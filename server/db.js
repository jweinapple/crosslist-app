import 'dotenv/config';
import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';

const scrypt = promisify(crypto.scrypt);

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.VERCEL
    ? path.join('/tmp', 'crosslist-data')
    : path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'crosslist.db');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

export const SESSION_COOKIE = 'crosslist_sid';
export const IDENTITY_COOKIE = 'crosslist_who';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MS = 15 * 60 * 1000;
export const PLATFORMS = ['ebay', 'facebook', 'depop', 'poshmark', 'etsy', 'reverb'];

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    google_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS connections (
    user_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    mode TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires INTEGER,
    account TEXT,
    extra_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, platform),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    extra_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);

  CREATE TABLE IF NOT EXISTS image_match_dismissals (
    user_id TEXT NOT NULL,
    pair_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, pair_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_logs(user_id, created_at);
`);

function tableHasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

if (!tableHasColumn('users', 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)');

function nowIso() {
  return new Date().toISOString();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const next = (await scrypt(password, salt, 64)).toString('hex');
  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(next, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function cookieSecurity() {
  const secure =
    process.env.VERCEL === '1' ||
    process.env.NODE_ENV === 'production' ||
    String(process.env.BASE_URL || '').startsWith('https://');
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function signingSecret() {
  const parts = [
    process.env.SESSION_SECRET,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.EBAY_CLIENT_SECRET,
  ].filter(Boolean);
  return parts.length ? parts.join(':') : 'crosslist-dev-session';
}

export function signValue(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function unsignValue(token, maxAgeMs) {
  const raw = String(token || '');
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (maxAgeMs && payload.t && Date.now() - Number(payload.t) > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

function googleIdForUser(userId) {
  if (!userId) return '';
  return db.prepare('SELECT google_id FROM users WHERE id = ?').get(userId)?.google_id || '';
}

export function setSessionCookie(res, sessionId, user) {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieSecurity()}; Max-Age=${Math.floor(SESSION_MS / 1000)}`
  );
  if (!user?.id || !user?.email) return;
  const token = signValue({
    id: user.id,
    email: user.email,
    name: user.name || '',
    google_id: user.google_id || googleIdForUser(user.id),
    t: Date.now(),
  });
  res.append(
    'Set-Cookie',
    `${IDENTITY_COOKIE}=${encodeURIComponent(token)}; ${cookieSecurity()}; Max-Age=${Math.floor(SESSION_MS / 1000)}`
  );
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieSecurity()}; Max-Age=0`);
  res.append('Set-Cookie', `${IDENTITY_COOKIE}=; ${cookieSecurity()}; Max-Age=0`);
}

export function restoreUserFromIdentityCookie(cookies) {
  const payload = unsignValue(cookies?.[IDENTITY_COOKIE], SESSION_MS);
  if (!payload?.id || !payload?.email) return null;
  const existing = loadUser(payload.id);
  if (existing) return existing;
  if (!payload.google_id) return null;
  try {
    return findOrCreateGoogleUser({
      googleId: payload.google_id,
      email: payload.email,
      name: payload.name || '',
    }).user;
  } catch {
    return null;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    createdAt: row.created_at,
  };
}

function applyConnection(user, row) {
  const extra = row.extra_json ? JSON.parse(row.extra_json) : {};
  Object.assign(user, extra);
  if (row.platform === 'ebay') {
    user.ebayToken = row.access_token;
    user.ebayRefreshToken = row.refresh_token;
    user.ebayTokenExpires = row.token_expires;
    user.ebayAccount = row.account;
  } else if (row.platform === 'facebook') {
    user.facebookToken = row.access_token;
    user.facebookTokenExpires = row.token_expires;
    user.facebookAccount = row.account;
  } else if (row.platform === 'depop') {
    user.depopToken = row.access_token;
    user.depopRefreshToken = row.refresh_token;
    user.depopTokenExpires = row.token_expires;
    user.depopAccount = row.account;
  } else if (row.platform === 'poshmark') {
    user.poshmarkToken = row.access_token;
    user.poshmarkRefreshToken = row.refresh_token;
    user.poshmarkAccount = row.account;
  } else if (row.platform === 'etsy') {
    user.etsyToken = row.access_token;
    user.etsyRefreshToken = row.refresh_token;
    user.etsyTokenExpires = row.token_expires;
    user.etsyAccount = row.account;
  } else if (row.platform === 'reverb') {
    user.reverbToken = row.access_token;
    user.reverbRefreshToken = row.refresh_token;
    user.reverbTokenExpires = row.token_expires;
    user.reverbAccount = row.account;
  }
}

function extractConnection(user, platform) {
  if (platform === 'ebay' && user.ebayToken) {
    return {
      mode: user.ebayExtension ? 'extension' : user.ebayDemo ? 'demo' : 'live',
      access_token: user.ebayToken,
      refresh_token: user.ebayRefreshToken || null,
      token_expires: user.ebayTokenExpires || null,
      account: user.ebayAccount || null,
      extra: {
        ebayDemo: Boolean(user.ebayDemo),
        ebayExtension: Boolean(user.ebayExtension),
      },
    };
  }
  if (platform === 'facebook' && user.facebookToken) {
    return {
      mode: user.facebookExtension ? 'extension' : user.facebookDemo ? 'demo' : 'live',
      access_token: user.facebookToken,
      refresh_token: null,
      token_expires: user.facebookTokenExpires || null,
      account: user.facebookAccount || null,
      extra: {
        facebookDemo: Boolean(user.facebookDemo),
        facebookExtension: Boolean(user.facebookExtension),
        facebookPages: user.facebookPages || null,
      },
    };
  }
  if (platform === 'depop' && user.depopToken) {
    return {
      mode: user.depopExtension ? 'extension' : user.depopDemo ? 'demo' : 'live',
      access_token: user.depopToken,
      refresh_token: user.depopRefreshToken || null,
      token_expires: user.depopTokenExpires || null,
      account: user.depopAccount || null,
      extra: {
        depopDemo: Boolean(user.depopDemo),
        depopExtension: Boolean(user.depopExtension),
      },
    };
  }
  if (platform === 'poshmark' && user.poshmarkToken) {
    return {
      mode: user.poshmarkExtension
        ? 'extension'
        : user.poshmarkDemo
          ? 'demo'
          : user.poshmarkPasswordLogin
            ? 'password'
            : 'live',
      access_token: user.poshmarkToken,
      refresh_token: user.poshmarkRefreshToken || null,
      token_expires: null,
      account: user.poshmarkAccount || null,
      extra: {
        poshmarkDemo: Boolean(user.poshmarkDemo),
        poshmarkExtension: Boolean(user.poshmarkExtension),
        poshmarkPasswordLogin: Boolean(user.poshmarkPasswordLogin),
      },
    };
  }
  if (platform === 'etsy' && user.etsyToken) {
    return {
      mode: user.etsyExtension ? 'extension' : user.etsyDemo ? 'demo' : 'live',
      access_token: user.etsyToken,
      refresh_token: user.etsyRefreshToken || null,
      token_expires: user.etsyTokenExpires || null,
      account: user.etsyAccount || null,
      extra: {
        etsyDemo: Boolean(user.etsyDemo),
        etsyExtension: Boolean(user.etsyExtension),
        etsyUserId: user.etsyUserId || null,
        etsyShopId: user.etsyShopId || null,
      },
    };
  }
  if (platform === 'reverb' && user.reverbToken) {
    return {
      mode: user.reverbExtension ? 'extension' : user.reverbDemo ? 'demo' : 'live',
      access_token: user.reverbToken,
      refresh_token: user.reverbRefreshToken || null,
      token_expires: user.reverbTokenExpires || null,
      account: user.reverbAccount || null,
      extra: {
        reverbDemo: Boolean(user.reverbDemo),
        reverbExtension: Boolean(user.reverbExtension),
        reverbUserId: user.reverbUserId || null,
        reverbShopId: user.reverbShopId || null,
      },
    };
  }
  return null;
}

export function loadUser(userId) {
  const row = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  const user = publicUser(row);
  const connections = db.prepare('SELECT * FROM connections WHERE user_id = ?').all(userId);
  for (const connection of connections) applyConnection(user, connection);
  return user;
}

export function saveUser(user) {
  if (!user?.id) return;
  db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(user.name || '', nowIso(), user.id);
  const upsert = db.prepare(`
    INSERT INTO connections (user_id, platform, mode, access_token, refresh_token, token_expires, account, extra_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, platform) DO UPDATE SET
      mode = excluded.mode,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires = excluded.token_expires,
      account = excluded.account,
      extra_json = excluded.extra_json,
      updated_at = excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM connections WHERE user_id = ? AND platform = ?');
  for (const platform of PLATFORMS) {
    const payload = extractConnection(user, platform);
    if (!payload) {
      remove.run(user.id, platform);
      continue;
    }
    upsert.run(
      user.id,
      platform,
      payload.mode,
      payload.access_token,
      payload.refresh_token,
      payload.token_expires,
      payload.account,
      JSON.stringify(payload.extra || {}),
      nowIso()
    );
  }
}

export function loadListings(userId) {
  const map = new Map();
  const rows = db.prepare('SELECT id, data_json FROM listings WHERE user_id = ?').all(userId);
  for (const row of rows) {
    try {
      const listing = JSON.parse(row.data_json);
      if (listing?.id) map.set(listing.id, listing);
    } catch (error) {
      console.warn('Skipping corrupt listing row', row.id, error.message);
    }
  }
  return map;
}

export function upsertListing(userId, listing) {
  if (!userId || !listing?.id) return;
  db.prepare(`
    INSERT INTO listings (id, user_id, data_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(listing.id, userId, JSON.stringify(listing), nowIso());
}

export function deleteListing(userId, listingId) {
  db.prepare('DELETE FROM listings WHERE user_id = ? AND id = ?').run(userId, listingId);
}

export function saveListings(userId, listingsMap) {
  if (!userId || !listingsMap) return;
  const persist = db.transaction(() => {
    db.prepare('DELETE FROM listings WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO listings (id, user_id, data_json, updated_at) VALUES (?, ?, ?, ?)'
    );
    for (const listing of listingsMap.values()) {
      if (!listing?.id) continue;
      insert.run(listing.id, userId, JSON.stringify(listing), nowIso());
    }
  });
  persist();
}

function wrapListingMap(userId, map) {
  const originalSet = map.set.bind(map);
  const originalDelete = map.delete.bind(map);
  const originalClear = map.clear.bind(map);
  map.set = (key, value) => {
    const result = originalSet(key, value);
    upsertListing(userId, value);
    return result;
  };
  map.delete = (key) => {
    const result = originalDelete(key);
    if (result) deleteListing(userId, key);
    return result;
  };
  map.clear = () => {
    originalClear();
    db.prepare('DELETE FROM listings WHERE user_id = ?').run(userId);
    return map;
  };
  return map;
}

export function listingMapFor(userId) {
  return wrapListingMap(userId, loadListings(userId));
}

export function imageMatchPairKey(a, b) {
  return [String(a), String(b)].sort().join('::');
}

export function listImageMatchDismissals(userId) {
  if (!userId) return [];
  return db
    .prepare('SELECT pair_key FROM image_match_dismissals WHERE user_id = ?')
    .all(userId)
    .map((row) => row.pair_key);
}

export function dismissImageMatchPairs(userId, pairKeys) {
  if (!userId || !pairKeys?.length) return;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO image_match_dismissals (user_id, pair_key, created_at) VALUES (?, ?, ?)'
  );
  const created = nowIso();
  for (const key of pairKeys) {
    if (!key) continue;
    insert.run(userId, String(key), created);
  }
}

export async function createUser({ email, password, name }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    const error = new Error('Enter a valid email address');
    error.status = 400;
    throw error;
  }
  if (String(password || '').length < 8) {
    const error = new Error('Password must be at least 8 characters');
    error.status = 400;
    throw error;
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const error = new Error('An account with that email already exists');
    error.status = 409;
    throw error;
  }
  const id = uuidv4();
  const created = nowIso();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, normalized, await hashPassword(password), String(name || '').trim(), created, created);
  claimLegacyStore(id);
  return loadUser(id);
}

export async function authenticateUser(email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (row && String(row.password_hash || '').startsWith('oauth:')) {
    const error = new Error('This account uses Google sign-in. Continue with Google instead.');
    error.status = 401;
    throw error;
  }
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    const error = new Error('Invalid email or password');
    error.status = 401;
    throw error;
  }
  return loadUser(row.id);
}

export function findOrCreateGoogleUser({ googleId, email, name }) {
  const sub = String(googleId || '').trim();
  const normalized = String(email || '').trim().toLowerCase();
  if (!sub) {
    const error = new Error('Google account is missing an ID');
    error.status = 400;
    throw error;
  }
  if (!normalized || !normalized.includes('@')) {
    const error = new Error('Google account did not provide an email');
    error.status = 400;
    throw error;
  }

  const byGoogle = db.prepare('SELECT * FROM users WHERE google_id = ?').get(sub);
  if (byGoogle) {
    const nextName = String(name || '').trim() || byGoogle.name || '';
    db.prepare('UPDATE users SET email = ?, name = ?, updated_at = ? WHERE id = ?').run(
      normalized,
      nextName,
      nowIso(),
      byGoogle.id
    );
    return { user: loadUser(byGoogle.id), created: false };
  }

  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (byEmail) {
    if (byEmail.google_id && byEmail.google_id !== sub) {
      const error = new Error('An account with that email already exists');
      error.status = 409;
      throw error;
    }
    const nextName = String(name || '').trim() || byEmail.name || '';
    // Signup does not verify email ownership, so anyone could have pre-registered this
    // address with a password they know. Linking Google proves ownership: drop the
    // password and every existing session so only the Google identity can sign in.
    if (!String(byEmail.password_hash || '').startsWith('oauth:')) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('oauth:google', byEmail.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(byEmail.id);
    }
    db.prepare('UPDATE users SET google_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
      sub,
      nextName,
      nowIso(),
      byEmail.id
    );
    return { user: loadUser(byEmail.id), created: false };
  }

  const id = uuidv4();
  const created = nowIso();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, google_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, normalized, 'oauth:google', String(name || '').trim(), sub, created, created);
  claimLegacyStore(id);
  return { user: loadUser(id), created: true };
}

export function createSession(userId) {
  const id = uuidv4();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    Date.now() + SESSION_MS,
    nowIso()
  );
  return id;
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return row;
}

export function deleteSession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function saveOAuthState(state, userId, platform, extra = {}) {
  db.prepare(
    'INSERT OR REPLACE INTO oauth_states (state, user_id, platform, extra_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(state, userId, platform, JSON.stringify(extra || {}), Date.now());
}

export function issueOAuthState(userId, platform, extra = {}) {
  const payload = {
    u: userId || '',
    p: platform,
    e: extra || {},
    t: Date.now(),
  };
  const state = signValue(payload);
  try {
    saveOAuthState(state, userId || '', platform, extra);
  } catch {
    // Vercel /tmp sqlite can fail across instances; the signed state is enough.
  }
  return state;
}

function readOAuthStateRow(state) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (Date.now() - row.created_at > OAUTH_STATE_MS) return null;
  return {
    userId: row.user_id,
    platform: row.platform,
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

export function consumeOAuthState(state) {
  if (!state) return null;
  try {
    const row = readOAuthStateRow(state);
    if (row) return row;
  } catch {
    // Fall through to the signed token when sqlite is empty or ephemeral.
  }
  const payload = unsignValue(state, OAUTH_STATE_MS);
  if (!payload?.p) return null;
  return {
    userId: payload.u || '',
    platform: payload.p,
    extra: payload.e && typeof payload.e === 'object' ? payload.e : {},
  };
}

const ACTIVITY_LIMIT = 500;

function serializeActivityDetail(detail) {
  if (detail == null || detail === '') return null;
  try {
    return JSON.stringify(detail);
  } catch (error) {
    console.warn('Could not serialize activity detail:', error.message);
    return JSON.stringify(String(detail));
  }
}

export function appendActivity(userId, entry = {}) {
  if (!userId || !entry.message) return null;
  const row = {
    id: entry.id || uuidv4(),
    user_id: userId,
    created_at: entry.at || nowIso(),
    type: ['success', 'error', 'info'].includes(entry.type) ? entry.type : 'info',
    source: String(entry.source || 'app').slice(0, 40),
    message: String(entry.message).slice(0, 2000),
    detail_json: serializeActivityDetail(entry.detail),
  };
  db.prepare(`
    INSERT OR REPLACE INTO activity_logs (id, user_id, created_at, type, source, message, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.user_id, row.created_at, row.type, row.source, row.message, row.detail_json);

  const count = db.prepare('SELECT COUNT(*) AS n FROM activity_logs WHERE user_id = ?').get(userId)?.n || 0;
  if (count > ACTIVITY_LIMIT) {
    db.prepare(`
      DELETE FROM activity_logs
      WHERE id IN (
        SELECT id FROM activity_logs
        WHERE user_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(userId, count - ACTIVITY_LIMIT);
  }
  return row.id;
}

export function listActivity(userId, limit = 400) {
  if (!userId) return [];
  const rows = db.prepare(`
    SELECT id, created_at, type, source, message, detail_json
    FROM activity_logs
    WHERE user_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(userId, Math.min(Math.max(Number(limit) || 400, 1), ACTIVITY_LIMIT));
  return rows.map((row) => {
    let detail = null;
    if (row.detail_json) {
      try {
        detail = JSON.parse(row.detail_json);
      } catch {
        detail = row.detail_json;
      }
    }
    return {
      id: row.id,
      at: row.created_at,
      type: row.type,
      source: row.source,
      message: row.message,
      detail,
    };
  });
}

export function clearActivity(userId) {
  if (!userId) return;
  db.prepare('DELETE FROM activity_logs WHERE user_id = ?').run(userId);
}

const FAILURE_ID = /^[0-9a-zA-Z_-]{8,80}$/;

export function hasListingFailure(userId, failureId) {
  if (!userId || !FAILURE_ID.test(String(failureId || ''))) return false;
  const marker = `"failureId":"${failureId}"`;
  const row = db.prepare(`
    SELECT id FROM activity_logs
    WHERE user_id = ? AND instr(detail_json, ?) > 0
    LIMIT 1
  `).get(userId, marker);
  return Boolean(row);
}

function claimLegacyStore(userId) {
  const migrated = db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_store');
  if (migrated) return;
  try {
    if (!fs.existsSync(STORE_FILE)) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated_store', nowIso());
      return;
    }
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (Array.isArray(data.listings)) {
      for (const listing of data.listings) {
        if (listing?.id) upsertListing(userId, listing);
      }
    }
  } catch (error) {
    console.warn('Could not migrate local store.json:', error.message);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated_store', nowIso());
}
