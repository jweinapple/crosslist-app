import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import * as userStore from './server/db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const requestContext = new AsyncLocalStorage();

if (process.env.VERCEL) {
  app.set('trust proxy', 1);
}

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

function currentListings() {
  return requestContext.getStore()?.listings || new Map();
}

const listings = new Proxy(new Map(), {
  get(_target, prop) {
    const map = currentListings();
    const value = map[prop];
    return typeof value === 'function' ? value.bind(map) : Reflect.get(map, prop);
  },
});

function persistStore() {
  const user = requestContext.getStore()?.user;
  if (user) userStore.saveUser(user);
}

function getCurrentUser() {
  return requestContext.getStore()?.user || null;
}

function getDemoUser() {
  const user = getCurrentUser();
  if (!user) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  return user;
}

function isPublicApi(req) {
  const route = `${req.method} ${req.path}`;
  return (
    route === 'GET /api/health' ||
    route === 'GET /api/auth/me' ||
    route === 'POST /api/auth/signup' ||
    route === 'POST /api/auth/login' ||
    route === 'POST /api/auth/logout' ||
    (req.method === 'GET' &&
      /^\/api\/auth\/(ebay|facebook|depop|etsy|google)(\/live|\/callback)?$/.test(req.path))
  );
}

function requirePageLogin(req, res) {
  if (req.user) return true;
  res.redirect('/dashboard.html?auth=required');
  return false;
}

function beginOAuth(req, res, platform, extra = {}) {
  if (!requirePageLogin(req, res)) return null;
  const state = uuidv4();
  userStore.saveOAuthState(state, req.user.id, platform, extra);
  return state;
}

function userFromOAuthState(state) {
  const oauth = userStore.consumeOAuthState(state);
  if (!oauth) return null;
  return { oauth, user: userStore.loadUser(oauth.userId) };
}

app.use((req, res, next) => {
  const sid = userStore.parseCookies(req)[userStore.SESSION_COOKIE];
  const session = userStore.getSession(sid);
  const user = session ? userStore.loadUser(session.user_id) : null;
  req.user = user;
  req.sessionId = session?.id || null;
  const listingsMap = user ? userStore.listingMapFor(user.id) : new Map();
  requestContext.run({ user, listings: listingsMap }, next);
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || isPublicApi(req)) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
});

const QUIET_API = new Set([
  'GET /api/health',
  'GET /api/auth/me',
  'GET /api/auth/status',
]);

const SECRET_KEYS = /password|secret|token|authorization|cookie|code|refresh/i;

function redactValue(key, value, depth = 0) {
  if (value == null) return value;
  if (SECRET_KEYS.test(String(key || ''))) return '[redacted]';
  if (Array.isArray(value)) {
    return depth > 2 ? `[${value.length} items]` : value.slice(0, 8).map((item, i) => redactValue(i, item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    const out = {};
    for (const [nextKey, nextValue] of Object.entries(value).slice(0, 20)) {
      out[nextKey] = redactValue(nextKey, nextValue, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 180) return `${value.slice(0, 177)}…`;
  return value;
}

function recordActivity(type, message, detail, req = null) {
  const user = req?.user || getCurrentUser();
  if (!user?.id || !message) return;
  try {
    userStore.appendActivity(user.id, {
      type,
      source: detail?.source || 'server',
      message,
      detail,
    });
  } catch (error) {
    console.warn('Failed to record activity:', error.message);
  }
}

function serializeError(error) {
  if (error == null) return { message: 'Unknown error' };
  if (typeof error !== 'object') return { message: String(error) };
  return {
    message: error.message || String(error),
    status: error.status || error.response?.status || undefined,
    data: redactValue('data', error.response?.data),
    stack: error.stack,
  };
}

function logError(context, error, extra = {}) {
  const axiosData = error?.response?.data;
  const fallback = error?.message || (typeof error === 'string' ? error : 'Unknown error');
  const message = extra.message || `${context}: ${typeof axiosData === 'string' ? axiosData : fallback}`;
  const detail = {
    source: extra.source || 'server',
    context,
    error: serializeError(error),
    ...(extra.detail || {}),
  };
  console.error(message, axiosData || error);
  if (extra.req) extra.req.loggedError = true;
  recordActivity('error', message, detail, extra.req);
}

process.on('unhandledRejection', (error) => {
  logError('unhandledRejection', error);
});
process.on('uncaughtException', (error) => {
  logError('uncaughtException', error);
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const route = `${req.method} ${req.path}`;
  if (QUIET_API.has(route)) return next();
  const started = Date.now();
  res.on('finish', () => {
    const user = req.user;
    if (!user) return;
    const status = res.statusCode;
    if (status === 304) return;
    if (req.method === 'GET' && req.path === '/api/listings/image-matches') return;
    if (status >= 400 && req.loggedError) return;
    const type = status >= 400 ? 'error' : req.method === 'GET' ? 'info' : 'success';
    const detail = {
      method: req.method,
      path: req.path,
      status,
      ms: Date.now() - started,
    };
    if (req.method !== 'GET' && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      detail.body = redactValue('body', req.body);
    }
    recordActivity(type, `${req.method} ${req.path} → ${status}`, detail, req);
  });
  next();
});

function resolveBaseUrl() {
  const explicit = String(process.env.BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${PORT}`;
}

const BASE_URL = resolveBaseUrl();

const UPLOADS_DIR = path.join(userStore.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).toLowerCase();
  return v.includes('your_') || v.includes('_here') || v === 'changeme';
}

const ebayLiveMode =
  !isPlaceholder(process.env.EBAY_CLIENT_ID) &&
  !isPlaceholder(process.env.EBAY_CLIENT_SECRET);

const depopLiveMode =
  !isPlaceholder(process.env.DEPOP_CLIENT_ID) &&
  !isPlaceholder(process.env.DEPOP_CLIENT_SECRET);

function getEtsyApiKey() {
  return process.env.ETSY_API_KEY || process.env.ETSY_CLIENT_ID || '';
}

const etsyLiveMode = !isPlaceholder(getEtsyApiKey());

const googleLiveMode =
  !isPlaceholder(process.env.GOOGLE_CLIENT_ID) &&
  !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET);

function googleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/api/auth/google/callback`;
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function ebayUsesProduction() {
  if (process.env.EBAY_USE_PRODUCTION === 'false') return false;
  if (process.env.EBAY_USE_PRODUCTION === 'true') return true;
  const auth = process.env.EBAY_AUTH_BASE_URL || '';
  const api = process.env.EBAY_BASE_URL || '';
  if (auth.includes('sandbox') || api.includes('sandbox')) return false;
  // Production lets sellers use Google SSO on eBay's official OAuth page.
  return true;
}

function getEbayAuthBase() {
  return ebayUsesProduction() ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
}

function getEbayApiBase() {
  return ebayUsesProduction() ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

const TITLE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'with',
  'from',
  'this',
  'that',
  'very',
  'gently',
  'official',
  'officially',
  'licensed',
  'merch',
  'show',
  'used',
  'new',
  'nwt',
  'nwot',
  'size',
  'sz',
  'mens',
  'men',
  'womens',
  'women',
  'man',
  'woman',
  'unisex',
  'in',
  'on',
  'of',
  'to',
  'by',
  'at',
  'as',
  'is',
  'it',
  'its',
  'into',
  'condition',
  'good',
  'great',
  'excellent',
  'perfect',
  'like',
  'please',
  'read',
  'description',
  'shipping',
  'free',
  'album',
  'panel',
  'mint',
  'heavily',
  'worn',
]);
const TITLE_SIZE_WORDS = new Set([
  'xs',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'xxxl',
  '2xl',
  '3xl',
  'small',
  'medium',
  'large',
]);

function stripTitleJunk(title) {
  return String(title || '')
    .replace(/\boffer expired\b/gi, ' ')
    .replace(/\bnew notification\b/gi, ' ')
    .replace(/notification.*$/gi, ' ')
    .replace(/\breach more buyers\b/gi, ' ')
    .replace(/\bbuy it now\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseRepeatedTitle(title) {
  const text = stripTitleJunk(String(title || '').replace(/\s+/g, ' '));
  if (text.length < 24) return text;
  const lower = text.toLowerCase();
  const start = lower.slice(0, Math.min(24, Math.floor(text.length / 2)));
  let idx = lower.indexOf(start, 12);
  while (idx !== -1) {
    const left = text.slice(0, idx).replace(/[\s\-|:–—]+$/g, '');
    const right = text.slice(idx);
    const leftN = left.toLowerCase();
    const rightN = right.toLowerCase();
    let same = 0;
    const check = Math.min(leftN.length, rightN.length);
    while (same < check && leftN[same] === rightN[same]) same += 1;
    if (left.length >= 16 && same >= Math.min(16, Math.floor(leftN.length * 0.6))) {
      return left.trim();
    }
    idx = lower.indexOf(start, idx + 1);
  }
  return text;
}

function cleanedListingTitle(title) {
  return collapseRepeatedTitle(title);
}

function normalizeTitle(title) {
  return collapseRepeatedTitle(title)
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/\bgrey\b/g, 'gray')
    .replace(/\bcolour\b/g, 'color')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title) {
  const tokens = new Set();
  for (const token of normalizeTitle(title).split(' ')) {
    if (!token || token.length < 2) continue;
    if (TITLE_STOPWORDS.has(token) || TITLE_SIZE_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function titleSimilarity(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return { shared: 0, jaccard: 0, containment: 0 };
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return {
    shared,
    jaccard: shared / (left.size + right.size - shared),
    containment: shared / Math.min(left.size, right.size),
  };
}

function titlesAreSameProduct(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left && left === right) return true;
  const { shared, jaccard, containment } = titleSimilarity(a, b);
  if (shared >= 5 && containment >= 0.7) return true;
  if (shared >= 4 && containment >= 0.7 && jaccard >= 0.45) return true;
  if (shared >= 6 && containment >= 0.5) return true;
  return false;
}

function titlesLookRelated(a, b) {
  if (titlesAreSameProduct(a, b)) return true;
  const { shared, jaccard, containment } = titleSimilarity(a, b);
  return shared >= 3 && (containment >= 0.42 || jaccard >= 0.24);
}

function decoratePlatformEntry(entry, listing) {
  const source = entry && typeof entry === 'object' ? entry : {};
  return {
    listingId: source.listingId || listing?.platformListingId || listing?.id || null,
    url: source.url || listing?.url || null,
    status: source.status || listing?.status || 'active',
    price: parseListingPrice(source.price) || parseListingPrice(listing?.price) || 0,
    images: realListingImages(
      Array.isArray(source.images) && source.images.length ? source.images : listing?.images || []
    ),
  };
}

function getPlatforms(listing) {
  if (listing?.platforms && typeof listing.platforms === 'object' && !Array.isArray(listing.platforms)) {
    const platforms = {};
    for (const [platform, entry] of Object.entries(listing.platforms)) {
      if (!entry) continue;
      platforms[platform] = decoratePlatformEntry(entry, listing);
    }
    return platforms;
  }
  const platforms = {};
  if (listing?.platform) {
    platforms[listing.platform] = decoratePlatformEntry(
      {
        listingId: listing.platformListingId || listing.id,
        url: listing.url || null,
        status: listing.status || 'active',
      },
      listing
    );
  }
  return platforms;
}

function listingHasPlatform(listing, platform) {
  return Boolean(getPlatforms(listing)[platform]);
}

function toUnifiedListing(listing) {
  const { platform, platformListingId, url, ...rest } = listing;
  return {
    ...rest,
    platforms: getPlatforms(listing),
    lastUpdated: listing.lastUpdated || new Date().toISOString(),
  };
}

function facebookPushListing(listing) {
  const fb = getPlatforms(listing).facebook;
  if (!fb?.listingId) return null;
  return {
    id: listing.id,
    price: listing.price,
    platformListingId: fb.listingId,
  };
}

function findExistingListing(incoming) {
  if (incoming?.id && listings.has(incoming.id)) {
    return listings.get(incoming.id);
  }

  const platform = incoming?.platform;
  const platformListingId = incoming?.platformListingId;
  if (platform && platformListingId) {
    for (const listing of listings.values()) {
      const entry = getPlatforms(listing)[platform];
      if (entry?.listingId && String(entry.listingId) === String(platformListingId)) {
        return listing;
      }
    }
  }

  const titleKey = normalizeTitle(incoming?.title);
  if (titleKey) {
    for (const listing of listings.values()) {
      if (normalizeTitle(listing.title) === titleKey) return listing;
    }
  }

  let best = null;
  let bestScore = 0;
  for (const listing of listings.values()) {
    if (platform && listingHasPlatform(listing, platform)) continue;
    if (!titlesAreSameProduct(incoming?.title, listing.title)) continue;
    const { shared, jaccard, containment } = titleSimilarity(incoming?.title, listing.title);
    const score = shared * 2 + containment + jaccard;
    if (score > bestScore) {
      best = listing;
      bestScore = score;
    }
  }
  return best;
}

const IMAGE_QUERY_DROP = new Set([
  'w',
  'h',
  'width',
  'height',
  'fit',
  'crop',
  'q',
  'quality',
  'size',
  'format',
  'fm',
  'auto',
  'dpr',
  'usm',
  'cs',
  'v',
  'cache',
  't',
  'timestamp',
  '_',
]);

function normalizeImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.pathname = parsed.pathname
      .replace(/\/s-l\d+\.(jpe?g|png|webp|gif)$/i, '/s-l.$1')
      .replace(/[_-](\d+x\d+|large|medium|small|thumb)\b/gi, '');
    const kept = [];
    parsed.searchParams.forEach((value, key) => {
      if (!IMAGE_QUERY_DROP.has(key.toLowerCase())) kept.push([key, value]);
    });
    kept.sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    return parsed.toString();
  } catch {
    return raw.split('#')[0].toLowerCase();
  }
}

function isRealListingImage(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value.startsWith('/uploads/')) return true;
  if (value.startsWith('data:image/')) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  return !/placehold\.co|via\.placeholder|placeholder\.com|dummyimage/i.test(value);
}

function realListingImages(list) {
  return [...new Set((list || []).map((image) => String(image || '').trim()).filter(isRealListingImage))];
}

function extractOgImage(html) {
  const text = String(html || '');
  const patterns = [
    /property=["']og:image["'][^>]*content=["']([^"']+)/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /["']og:image["']\s*content=["']([^"']+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && isRealListingImage(match[1])) return match[1];
  }
  return '';
}

async function fetchHtml(url) {
  const cookieJar = [];
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await axios.get(current, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: cookieJar.join('; '),
      },
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      responseType: 'text',
    });
    for (const cookie of response.headers['set-cookie'] || []) {
      const pair = String(cookie).split(';')[0];
      if (pair) cookieJar.push(pair);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    return String(response.data || '');
  }
  return '';
}

function ebayItemIdFromListing(listing) {
  const entry = getPlatforms(listing).ebay;
  const id = String(entry?.listingId || '');
  return /^\d{9,13}$/.test(id) ? id : '';
}

async function fetchListingThumbnail(listing) {
  const ebayId = ebayItemIdFromListing(listing);
  if (ebayId) {
    const image = extractOgImage(await fetchHtml(`https://m.ebay.com/itm/${ebayId}`));
    if (image) return image;
  }
  for (const platform of ['depop', 'poshmark', 'etsy', 'facebook']) {
    const url = getPlatforms(listing)[platform]?.url;
    if (!url) continue;
    try {
      const image = extractOgImage(await fetchHtml(url));
      if (image) return image;
    } catch (error) {
      logError('Listing thumbnail fetch', error, { detail: { url, listingId: listing?.id } });
    }
  }
  return '';
}

function listingNeedsImageHydration(listing) {
  if (realListingImages(listing?.images).length) return false;
  const attempted = Date.parse(listing?.imageHydrationAttemptedAt || '') || 0;
  return Date.now() - attempted > 6 * 60 * 60 * 1000;
}

async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

function applyListingImages(listing, images) {
  const nextImages = realListingImages(images);
  if (!nextImages.length) return listing;
  const platforms = getPlatforms(listing);
  for (const [platform, entry] of Object.entries(platforms)) {
    if (!realListingImages(entry.images).length) {
      platforms[platform] = { ...entry, images: nextImages };
    }
  }
  return {
    ...toUnifiedListing(listing),
    images: nextImages,
    platforms,
    lastUpdated: new Date().toISOString(),
  };
}

async function hydrateListingImages(listing) {
  if (!listingNeedsImageHydration(listing)) return listing;
  let image = '';
  try {
    image = await fetchListingThumbnail(listing);
  } catch (error) {
    logError('Listing image hydration', error, { detail: { listingId: listing?.id, title: listing?.title } });
  }
  const updated = {
    ...(image ? applyListingImages(listing, [image, ...(listing.images || [])]) : toUnifiedListing(listing)),
    imageHydrationAttemptedAt: new Date().toISOString(),
  };
  listings.set(updated.id, updated);
  return updated;
}

async function hydrateMissingListingImages(targets) {
  const pending = (targets || Array.from(listings.values())).filter(listingNeedsImageHydration);
  if (!pending.length) return [];
  return mapPool(pending, 4, hydrateListingImages);
}

function listingImageList(listing) {
  const images = [...(listing?.images || [])];
  for (const entry of Object.values(getPlatforms(listing))) {
    if (Array.isArray(entry?.images)) images.push(...entry.images);
  }
  return images;
}

function listingImageKeys(listing) {
  const keys = new Set();
  for (const image of listingImageList(listing)) {
    const url = String(image || '').trim();
    if (!url) continue;
    const normalized = normalizeImageUrl(url);
    if (normalized) keys.add(normalized);
    try {
      const parsed = new URL(url);
      const ebayId = parsed.pathname.match(/\/g\/([^/]+)\//i);
      if (ebayId?.[1]) keys.add(`ebayimg:${ebayId[1]}`);
    } catch {
      // Ignore malformed image URLs.
    }
  }
  keys.delete('');
  return keys;
}

function listingsShareImage(a, b) {
  const otherKeys = listingImageKeys(b);
  if (!otherKeys.size) return false;
  for (const key of listingImageKeys(a)) {
    if (otherKeys.has(key)) return true;
  }
  return false;
}

function listingPlatformKeys(listing) {
  return Object.keys(getPlatforms(listing)).filter(Boolean);
}

function platformsOverlap(a, b) {
  const other = new Set(listingPlatformKeys(b));
  return listingPlatformKeys(a).some((platform) => other.has(platform));
}

function summarizeMatchListing(listing) {
  const unified = toUnifiedListing(listing);
  const platforms = getPlatforms(unified);
  return {
    id: unified.id,
    title: unified.title,
    price: parseListingPrice(unified.price),
    images: unified.images || [],
    platforms,
    lastUpdated: unified.lastUpdated,
  };
}

function findImageMatchInInventory(incoming, platform) {
  const incomingKeys = listingImageKeys(incoming);
  let best = null;
  let bestScore = 0;
  for (const listing of listings.values()) {
    if (platform && listingHasPlatform(listing, platform)) continue;
    if (titlesAreSameProduct(incoming?.title, listing.title)) continue;
    const related = titlesLookRelated(incoming?.title, listing.title);
    const sharedImage = incomingKeys.size ? listingsShareImage(incoming, listing) : false;
    if (!related && !sharedImage) continue;
    const { shared, jaccard, containment } = titleSimilarity(incoming?.title, listing.title);
    const score = (sharedImage ? 4 : 0) + shared + containment + jaccard;
    if (score > bestScore) {
      best = listing;
      bestScore = score;
    }
  }
  return best;
}

function findImageMatchGroups() {
  const items = Array.from(listings.values()).map((listing) => toUnifiedListing(listing));
  const dismissed = new Set(userStore.listImageMatchDismissals(getCurrentUser()?.id));
  const parent = new Map(items.map((item) => [item.id, item.id]));

  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (dismissed.has(userStore.imageMatchPairKey(left.id, right.id))) continue;
      if (platformsOverlap(left, right)) continue;
      if (!listingsShareImage(left, right) && !titlesLookRelated(left.title, right.title)) continue;
      union(left.id, right.id);
    }
  }

  const grouped = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(item);
  }

  return [...grouped.values()]
    .map((members) => {
      if (members.length < 2) return null;
      const platformSet = new Set(members.flatMap(listingPlatformKeys));
      if (platformSet.size < 2) return null;
      members.sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));
      return {
        id: members.map((item) => item.id).sort().join('::'),
        items: members.map(summarizeMatchListing),
      };
    })
    .filter(Boolean);
}

function mergeInventoryListings(primaryId, matchIds) {
  const primary = listings.get(primaryId);
  if (!primary) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }

  const platforms = {};
  for (const [platform, entry] of Object.entries(getPlatforms(primary))) {
    platforms[platform] = decoratePlatformEntry(entry, primary);
  }
  const images = [...listingImageList(primary)];
  const seenImages = new Set(images.map((image) => normalizeImageUrl(image)).filter(Boolean));
  const mergedIds = [];

  for (const id of matchIds || []) {
    if (!id || id === primaryId) continue;
    const other = listings.get(id);
    if (!other) continue;
    if (listingPlatformKeys(other).some((platform) => platforms[platform])) continue;
    const otherPlatforms = getPlatforms(other);
    for (const [platform, entry] of Object.entries(otherPlatforms)) {
      if (!platforms[platform]) platforms[platform] = decoratePlatformEntry(entry, other);
    }
    for (const image of listingImageList(other)) {
      const key = normalizeImageUrl(image);
      if (!image || (key && seenImages.has(key))) continue;
      if (key) seenImages.add(key);
      images.push(image);
    }
    listings.delete(id);
    mergedIds.push(id);
  }

  const updated = {
    ...toUnifiedListing(primary),
    title: cleanedListingTitle(primary.title) || primary.title,
    description: primary.description || '',
    platforms,
    images,
    lastUpdated: new Date().toISOString(),
  };
  listings.set(primary.id, updated);
  return { listing: updated, mergedIds };
}

function pickPrimaryListing(members) {
  return [...members].sort((a, b) => {
    const platformDiff = listingPlatformKeys(b).length - listingPlatformKeys(a).length;
    if (platformDiff) return platformDiff;
    const imageDiff = listingImageList(b).length - listingImageList(a).length;
    if (imageDiff) return imageDiff;
    const titleA = cleanedListingTitle(a.title);
    const titleB = cleanedListingTitle(b.title);
    if (titleA.length !== titleB.length) return titleA.length - titleB.length;
    return String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || ''));
  })[0];
}

function mergeObviousDuplicateListings() {
  const items = Array.from(listings.values()).map((listing) => toUnifiedListing(listing));
  const parent = new Map(items.map((item) => [item.id, item.id]));

  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (platformsOverlap(left, right)) continue;
      if (!titlesAreSameProduct(left.title, right.title)) continue;
      union(left.id, right.id);
    }
  }

  const grouped = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(item);
  }

  let mergedCount = 0;
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const primary = pickPrimaryListing(members);
    const matchIds = members.map((item) => item.id).filter((id) => id !== primary.id);
    const result = mergeInventoryListings(primary.id, matchIds);
    mergedCount += result.mergedIds.length;
  }
  return mergedCount;
}

function cleanStoredListingTitles() {
  for (const listing of listings.values()) {
    const cleaned = cleanedListingTitle(listing.title);
    if (!cleaned || cleaned === listing.title) continue;
    listings.set(listing.id, {
      ...toUnifiedListing(listing),
      title: cleaned,
    });
  }
}

function upsertImportedListing(incoming) {
  if (!incoming) return null;
  const match = findExistingListing(incoming);

  if (match) {
    const platforms = getPlatforms(match);
    if (incoming.platform) {
      platforms[incoming.platform] = decoratePlatformEntry(
        {
          listingId: incoming.platformListingId || incoming.id,
          url: incoming.url || platforms[incoming.platform]?.url || null,
          status: incoming.status || 'active',
        },
        incoming
      );
    }
    const incomingTitle = cleanedListingTitle(incoming.title) || incoming.title;
    const matchTitle = cleanedListingTitle(match.title) || match.title;
    const preferredTitle =
      incomingTitle && matchTitle
        ? incomingTitle.length <= matchTitle.length
          ? incomingTitle
          : matchTitle
        : incomingTitle || matchTitle;
    const updated = {
      ...toUnifiedListing(match),
      title: preferredTitle,
      description: incoming.description || match.description || '',
      price: parseListingPrice(match.price) || parseListingPrice(incoming.price) || 0,
      quantity: incoming.quantity ?? match.quantity ?? 1,
      images: realListingImages([...(match.images || []), ...(incoming.images || [])]),
      platforms,
      lastUpdated: new Date().toISOString(),
    };
    listings.set(match.id, updated);
    return updated;
  }

  const created = {
    id: `item_${uuidv4()}`,
    title: cleanedListingTitle(incoming.title) || incoming.title || 'Untitled Item',
    description: incoming.description || '',
    price: parseListingPrice(incoming.price),
    quantity: incoming.quantity ?? 1,
    images: realListingImages(incoming.images),
    status: incoming.status || 'active',
    platforms: getPlatforms(incoming),
    lastUpdated: new Date().toISOString(),
  };
  listings.set(created.id, created);
  return created;
}

function seedDemoInventory() {
  const now = new Date().toISOString();
  const samples = [
    {
      id: 'item_demo_1',
      title: 'Vintage Nike Windbreaker (M)',
      description: 'Light wear, no stains.',
      price: 48,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Item+1'],
      status: 'active',
      sku: 'nike-windbreaker-m',
      platforms: {
        ebay: { listingId: 'demo_ebay_1', status: 'active', price: 48 },
        facebook: { listingId: 'demo_fb_1', status: 'active', price: 42 },
        depop: { listingId: 'demo_depop_1', status: 'active', price: 48 },
        poshmark: { listingId: 'demo_posh_1', status: 'active', price: 55 },
        etsy: { listingId: 'demo_etsy_1', status: 'active', price: 48 },
      },
      lastUpdated: now,
    },
    {
      id: 'item_demo_2',
      title: 'Carhartt Double Knee Pants 32x30',
      description: 'Great condition work pants.',
      price: 62.5,
      quantity: 2,
      images: ['https://placehold.co/300x200/png?text=Item+2'],
      status: 'active',
      sku: 'carhartt-dk-32x30',
      platforms: {
        ebay: { listingId: 'demo_ebay_2', status: 'active', price: 62.5 },
        facebook: { listingId: 'demo_fb_2', status: 'active', price: 62.5 },
        depop: { listingId: 'demo_depop_2', status: 'active', price: 62.5 },
      },
      lastUpdated: now,
    },
    {
      id: 'item_demo_3',
      title: 'Mid-Century Table Lamp',
      description: 'Works perfectly, local pickup preferred.',
      price: 35,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Item+3'],
      status: 'active',
      sku: 'mcm-table-lamp',
      platforms: {
        ebay: { listingId: 'demo_ebay_3', status: 'active', price: 35 },
        facebook: { listingId: 'demo_fb_3', status: 'active', price: 35 },
      },
      lastUpdated: now,
    },
  ];
  samples.forEach((listing) => {
    if (!listings.has(listing.id)) {
      listings.set(listing.id, listing);
    }
  });
  return samples.map((sample) => listings.get(sample.id));
}

function seedDemoEbayListings() {
  return seedDemoInventory();
}

function seedDemoFacebookListings() {
  return seedDemoInventory();
}

function buildMarketplaceCandidates(platform) {
  const now = new Date().toISOString();
  if (platform === 'depop') return buildDepopMarketplaceCandidates(now);
  if (platform === 'poshmark') return buildPoshmarkMarketplaceCandidates(now);
  if (platform === 'etsy') return buildEtsyMarketplaceCandidates(now);
  if (platform === 'ebay') {
    return [
      {
        title: 'Vintage Nike Windbreaker (M)',
        description: 'Light wear, no stains.',
        price: 48,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+1'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_1',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_1',
        lastUpdated: now,
      },
      {
        title: 'Carhartt Double Knee Pants 32x30',
        description: 'Great condition work pants.',
        price: 62.5,
        quantity: 2,
        images: ['https://placehold.co/300x200/png?text=eBay+2'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_2',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_2',
        lastUpdated: now,
      },
      {
        title: 'Patagonia Better Sweater Fleece (L)',
        description: 'Soft fleece, no pilling.',
        price: 54,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+3'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_patagonia',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_patagonia',
        lastUpdated: now,
      },
      {
        title: "Levi's 501 Jeans 32x32",
        description: 'Classic fit, lightly worn.',
        price: 38,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+4'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_levis',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_levis',
        lastUpdated: now,
      },
      {
        title: 'Nike Bleach Dye Acid Wash Blue Swoosh Tee Size L',
        description: 'Blue Nike tee with an all-over bleach / acid wash pattern. Size L.',
        price: 26.99,
        quantity: 1,
        images: ['https://placehold.co/600x600/3d7ea6/ffffff/png?text=Nike+Bleach+Tee'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_nike_bleach',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_nike_bleach',
        lastUpdated: now,
      },
    ];
  }

  return [
    {
      title: 'Mid-Century Table Lamp',
      description: 'Works perfectly, local pickup preferred.',
      price: 35,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+1'],
      platform: 'facebook',
      platformListingId: 'demo_fb_3',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_3',
      lastUpdated: now,
    },
    {
      title: 'IKEA Kallax Shelf (White)',
      description: 'Minor scuffs on one corner.',
      price: 55,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+2'],
      platform: 'facebook',
      platformListingId: 'demo_fb_kallax',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_kallax',
      lastUpdated: now,
    },
    {
      title: 'Vintage Persian Rug 5x8',
      description: 'Wool blend, recently cleaned.',
      price: 120,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+3'],
      platform: 'facebook',
      platformListingId: 'demo_fb_rug',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_rug',
      lastUpdated: now,
    },
    {
      title: 'Herman Miller Aeron Chair',
      description: 'Size B, fully loaded, light wear.',
      price: 425,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+4'],
      platform: 'facebook',
      platformListingId: 'demo_fb_aeron',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_aeron',
      lastUpdated: now,
    },
    {
      title: 'H&M grey skinny jeans. Size 33 waist. Slim/skinny fit versatile grey wash',
      description: 'Charcoal grey skinny jeans, size 33.',
      price: 28,
      quantity: 1,
      images: ['https://placehold.co/600x600/5c5c5c/ffffff/png?text=HM+Grey+Jeans'],
      platform: 'facebook',
      platformListingId: 'demo_fb_hm_jeans',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_hm_jeans',
      lastUpdated: now,
    },
  ];
}

function buildDepopMarketplaceCandidates(now) {
  return [
    {
      title: 'Vintage Band Tee (L)',
      description: 'Soft cotton, no holes.',
      price: 28,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+1'],
      platform: 'depop',
      platformListingId: 'demo_depop_tee',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_tee',
      lastUpdated: now,
    },
    {
      title: 'Chunky Knit Sweater',
      description: 'Oversized, barely worn.',
      price: 42,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+2'],
      platform: 'depop',
      platformListingId: 'demo_depop_sweater',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_sweater',
      lastUpdated: now,
    },
    {
      title: 'Nike Dunk Low Panda',
      description: 'Size 10, clean uppers.',
      price: 145,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+3'],
      platform: 'depop',
      platformListingId: 'demo_depop_dunks',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_dunks',
      lastUpdated: now,
    },
    {
      title: 'Nike short sleeve tee in blue with an all-over bleach dye / acid wash pattern',
      description: 'Blue Nike tee, bleach dye / acid wash. Size L.',
      price: 23,
      quantity: 1,
      images: ['https://placehold.co/600x600/3d7ea6/ffffff/png?text=Nike+Bleach+Tee'],
      platform: 'depop',
      platformListingId: 'demo_depop_nike_bleach',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_nike_bleach',
      lastUpdated: now,
    },
  ];
}

function buildPoshmarkMarketplaceCandidates(now) {
  return [
    {
      title: 'Lululemon Align Leggings (6)',
      description: 'Black, excellent condition.',
      price: 54,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+1'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_align',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_align',
      lastUpdated: now,
    },
    {
      title: 'Coach Shoulder Bag',
      description: 'Leather, light wear on corners.',
      price: 89,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+2'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_coach',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_coach',
      lastUpdated: now,
    },
    {
      title: 'Nike Air Max 90 (9.5)',
      description: 'Clean uppers, original box.',
      price: 72,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+3'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_airmax',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_airmax',
      lastUpdated: now,
    },
    {
      title: "H&M Skinny Fit Jeans Men's Size 33 Charcoal Gray Stretch Denim 5-Pocket",
      description: 'Charcoal grey skinny jeans, size 33.',
      price: 32,
      quantity: 1,
      images: ['https://placehold.co/600x600/5c5c5c/ffffff/png?text=HM+Grey+Jeans'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_hm_jeans',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_hm_jeans',
      lastUpdated: now,
    },
  ];
}

function buildEtsyMarketplaceCandidates(now) {
  return [
    {
      title: 'Handmade Ceramic Mug',
      description: 'Speckled glaze, dishwasher safe.',
      price: 24,
      quantity: 3,
      images: ['https://placehold.co/300x200/png?text=Etsy+1'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_mug',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_mug',
      lastUpdated: now,
    },
    {
      title: 'Custom Name Necklace',
      description: '14k gold fill, 16 inch chain.',
      price: 38,
      quantity: 5,
      images: ['https://placehold.co/300x200/png?text=Etsy+2'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_necklace',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_necklace',
      lastUpdated: now,
    },
    {
      title: 'Printable Wall Art Set',
      description: 'Three digital prints, instant download.',
      price: 12,
      quantity: 99,
      images: ['https://placehold.co/300x200/png?text=Etsy+3'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_prints',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_prints',
      lastUpdated: now,
    },
  ];
}

function annotateImportCandidates(candidates, platform) {
  return candidates.map((listing) => {
    const incoming = { ...listing, platform: listing.platform || platform };
    const match = findExistingListing(incoming);
    const imageMatch = match ? null : findImageMatchInInventory(incoming, platform);
    const alreadyImported = Boolean(match && listingHasPlatform(match, platform));
    return {
      ...incoming,
      alreadyImported,
      alreadyInInventory: Boolean(match),
      matchedItemId: match?.id || null,
      possibleImageMatch: Boolean(imageMatch),
      possibleImageMatchId: imageMatch?.id || null,
      possibleImageMatchTitle: imageMatch?.title || null,
    };
  });
}

function applyMoneyDivisor(divisor) {
  const value = Number(divisor);
  if (!Number.isFinite(value) || value <= 0) return 100;
  if (value >= 10) return value;
  return Math.pow(10, value);
}

function parseListingPrice(value, depth = 0) {
  if (value == null || value === '' || depth > 6) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseListingPrice(entry, depth + 1);
      if (parsed) return parsed;
    }
    return 0;
  }
  if (typeof value === 'object') {
    if (value.divisor != null && value.amount != null && typeof value.amount !== 'object') {
      const amount = Number(value.amount);
      if (Number.isFinite(amount) && amount > 0) {
        return amount / applyMoneyDivisor(value.divisor);
      }
    }
    const keys = [
      'priceAmount',
      'price_amount',
      'salePrice',
      'sale_price',
      'originalPrice',
      'original_price',
      'amount',
      'value',
      'price',
    ];
    for (const key of keys) {
      if (value[key] == null) continue;
      let parsed = parseListingPrice(value[key], depth + 1);
      if (!parsed) continue;
      if (value.divisor != null) {
        parsed /= applyMoneyDivisor(value.divisor);
      }
      return parsed;
    }
    return 0;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  const match =
    text.match(
      /(?:USD|CAD|GBP|EUR|AUD|US\$|CA\$|A\$|C\$|£|€|\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:USD|CAD|GBP|EUR|AUD)/i
    ) || text.match(/([\d,]+\.\d{2})/);
  if (match) {
    const amount = parseFloat(String(match[1] || match[2]).replace(/,/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }
  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function ebayAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function mapEbayInventoryItem(item, offer = {}) {
  const listingId = offer.listing?.listingId || offer.offerId || item.sku || uuidv4();
  return {
    title: item.product?.title || 'Untitled Item',
    description: item.product?.description || '',
    price: parseListingPrice(
      offer.pricingSummary?.price ||
        offer.pricingSummary?.auctionStartPrice ||
        item.price
    ),
    quantity:
      offer.availableQuantity ??
      item.availability?.shipToLocationAvailability?.quantity ??
      item.quantity ??
      1,
    images: item.product?.imageUrls || [],
    platform: 'ebay',
    platformListingId: String(listingId),
    status:
      offer.status === 'PUBLISHED' || offer.listing?.listingStatus === 'ACTIVE' || item.availability
        ? 'active'
        : 'inactive',
    url: offer.listing?.listingId ? `https://www.ebay.com/itm/${offer.listing.listingId}` : undefined,
  };
}

async function fetchLiveEbayCandidates(user) {
  let items = [];
  let offers = [];
  try {
    const response = await axios.get(`${getEbayApiBase()}/sell/inventory/v1/inventory_item`, {
      headers: ebayAuthHeaders(user.ebayToken),
      params: { limit: 200 },
    });
    items = response.data.inventoryItems || [];
  } catch (error) {
    logError('eBay inventory fetch', error);
  }

  try {
    const response = await axios.get(`${getEbayApiBase()}/sell/inventory/v1/offer`, {
      headers: ebayAuthHeaders(user.ebayToken),
      params: { limit: 200 },
    });
    offers = response.data.offers || response.data.offerResponses || [];
  } catch (error) {
    logError('eBay offer fetch', error);
  }

  const itemsBySku = new Map();
  for (const item of items) {
    if (item.sku) itemsBySku.set(item.sku, item);
  }

  if (offers.length) {
    return offers.map((offer) => mapEbayInventoryItem(itemsBySku.get(offer.sku) || {}, offer));
  }
  return items.map((item) => mapEbayInventoryItem(item));
}

function mapFacebookCatalogProduct(product) {
  return {
    title: product.title || 'Untitled Item',
    description: product.description || '',
    price: parseListingPrice(product.price) || parseListingPrice(product.sale_price),
    quantity: product.quantity || 1,
    images: product.image_url ? [product.image_url] : [],
    platform: 'facebook',
    platformListingId: product.id,
    status: product.availability === 'in_stock' ? 'active' : 'inactive',
  };
}

async function fetchLiveFacebookCandidates(user) {
  const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: { access_token: user.facebookToken },
  });
  if (!pagesResponse.data.data?.length) return [];

  const pageAccessToken = pagesResponse.data.data[0].access_token;
  const catalogResponse = await axios.get('https://graph.facebook.com/v18.0/me/product_catalogs', {
    params: { access_token: pageAccessToken },
  });
  if (!catalogResponse.data.data?.length) return [];

  const catalogId = catalogResponse.data.data[0].id;
  const productsResponse = await axios.get(`https://graph.facebook.com/v18.0/${catalogId}/products`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,title,description,price,image_url,availability,quantity',
    },
  });
  return (productsResponse.data.data || []).map(mapFacebookCatalogProduct);
}

function connectDemoEbay() {
  const user = getDemoUser();
  user.ebayToken = 'demo';
  user.ebayDemo = true;
  seedDemoEbayListings();
  return user;
}

function connectDemoFacebook() {
  const user = getDemoUser();
  user.facebookToken = 'demo';
  user.facebookDemo = true;
  seedDemoFacebookListings();
  return user;
}

// Serve static files from public directory
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/', (_req, res) => {
  res.redirect('/dashboard.html');
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ authenticated: false });
  return res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name || '',
    },
  });
});

app.post('/api/auth/signup', (req, res) => {
  try {
    const user = userStore.createUser({
      email: req.body?.email,
      password: req.body?.password,
      name: req.body?.name,
    });
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId);
    return res.status(201).json({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name || '' },
    });
  } catch (error) {
    logError('Signup', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Could not create account' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = userStore.authenticateUser(req.body?.email, req.body?.password);
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId);
    return res.json({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name || '' },
    });
  } catch (error) {
    logError('Login', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Could not sign in' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  userStore.deleteSession(req.sessionId);
  userStore.clearSessionCookie(res);
  return res.json({ authenticated: false });
});

app.get('/api/auth/google', (req, res) => {
  if (!googleLiveMode) {
    return res.redirect('/dashboard.html?authError=google-config');
  }
  const state = uuidv4();
  userStore.saveOAuthState(state, '', 'google');
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
  return res.redirect(authUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?authError=google');
  }
  const oauth = userStore.consumeOAuthState(String(state || ''));
  if (!oauth || oauth.platform !== 'google') {
    return res.redirect('/dashboard.html?authError=google');
  }

  try {
    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      return res.redirect('/dashboard.html?authError=google');
    }

    const profileResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = profileResponse.data || {};
    const emailVerified = profile.email_verified === true || profile.email_verified === 'true';
    if (!profile.sub || !profile.email || !emailVerified) {
      return res.redirect('/dashboard.html?authError=google');
    }

    const { user, created } = userStore.findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      name: profile.name || profile.given_name || '',
    });
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId);
    return res.redirect(created ? '/dashboard.html?googleSignup=1' : '/dashboard.html');
  } catch (oauthError) {
    logError('Google OAuth', oauthError, { req });
    return res.redirect('/dashboard.html?authError=google');
  }
});

function isExtensionToken(token) {
  return token === 'extension';
}

function getConnectionMode(user, platform) {
  if (platform === 'ebay') {
    if (user.ebayExtension || isExtensionToken(user.ebayToken)) return 'extension';
    if (user.ebayDemo) return 'demo';
    if (user.ebayToken) return 'live';
    return 'none';
  }
  if (platform === 'facebook') {
    if (user.facebookExtension || isExtensionToken(user.facebookToken)) return 'extension';
    if (user.facebookDemo) return 'demo';
    if (user.facebookToken) return 'live';
    return 'none';
  }
  if (platform === 'depop') {
    if (user.depopExtension || isExtensionToken(user.depopToken)) return 'extension';
    if (user.depopDemo) return 'demo';
    if (user.depopToken) return 'live';
    return 'none';
  }
  if (platform === 'poshmark') {
    if (user.poshmarkExtension || isExtensionToken(user.poshmarkToken)) return 'extension';
    if (user.poshmarkDemo) return 'demo';
    if (user.poshmarkToken) return user.poshmarkPasswordLogin ? 'password' : 'live';
    return 'none';
  }
  if (platform === 'etsy') {
    if (user.etsyExtension || isExtensionToken(user.etsyToken)) return 'extension';
    if (user.etsyDemo) return 'demo';
    if (user.etsyToken) return 'live';
    return 'none';
  }
  return 'none';
}

const IMPORT_PLATFORMS = ['ebay', 'facebook', 'depop', 'poshmark', 'etsy'];

function isRealConnectionMode(mode) {
  return mode === 'live' || mode === 'password' || mode === 'extension';
}

const CREATE_URLS = {
  ebay: 'https://www.ebay.com/sl/list',
  facebook: 'https://www.facebook.com/marketplace/create/item',
  depop: 'https://www.depop.com/products/create/',
  poshmark: 'https://poshmark.com/create-listing',
  etsy: 'https://www.etsy.com/your/shops/me/tools/listings/create',
};

function safeUserId(userId) {
  return String(userId || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function extFromMime(mime, filename = '') {
  const fromName = String(filename).toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
  if (fromName) return fromName[1] === 'jpeg' ? 'jpg' : fromName[1];
  const type = String(mime || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

function persistListingImage(userId, image) {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/uploads/')) return raw;
  if (/^https?:\/\//i.test(raw) && isRealListingImage(raw)) return raw;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!match) return '';
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) return '';
  const owner = safeUserId(userId);
  const dir = path.join(UPLOADS_DIR, owner);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${uuidv4()}.${extFromMime(match[1])}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return `/uploads/${owner}/${name}`;
}

function persistListingImages(userId, images = []) {
  return [...new Set((images || []).map((image) => persistListingImage(userId, image)).filter(Boolean))].slice(0, 8);
}

function connectedStores(user) {
  return IMPORT_PLATFORMS.map((id) => ({ id, mode: getConnectionMode(user, id) })).filter(
    (store) => store.mode && store.mode !== 'none'
  );
}

function requestedPushPlatforms(user, requested) {
  const connected = connectedStores(user);
  const wanted = Array.isArray(requested) && requested.length
    ? requested.map((value) => String(value).toLowerCase()).filter((id) => IMPORT_PLATFORMS.includes(id))
    : connected.map((store) => store.id);
  return wanted.map((id) => ({
    id,
    mode: getConnectionMode(user, id),
  }));
}

function mapEbayCondition(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  if (key === 'new') return 'NEW';
  if (key === 'like_new' || key === 'used_excellent') return 'USED_EXCELLENT';
  if (key === 'used_fair' || key === 'fair') return 'USED_ACCEPTABLE';
  return 'USED_GOOD';
}

function pendingPlatformEntry(listing, platform, extra = {}) {
  return {
    listingId: extra.listingId || null,
    url: extra.url || CREATE_URLS[platform] || null,
    status: extra.status || 'pending',
    price: parseListingPrice(listing.price),
    images: listing.images || [],
    error: extra.error || null,
    needsReview: Boolean(extra.needsReview),
  };
}

function applyPlatformResult(listing, platform, result = {}) {
  const platforms = getPlatforms(listing);
  const status = result.status || (result.listingId ? 'active' : result.error ? 'error' : 'listing');
  platforms[platform] = {
    ...pendingPlatformEntry(listing, platform),
    ...platforms[platform],
    listingId: result.listingId || platforms[platform]?.listingId || null,
    url: result.url || platforms[platform]?.url || CREATE_URLS[platform] || null,
    status,
    price: parseListingPrice(listing.price),
    images: listing.images || [],
    error: result.error || null,
    needsReview: Boolean(result.needsReview),
  };
  const listed = Object.values(platforms).some((entry) => {
    const value = String(entry?.status || '').toLowerCase();
    return entry?.listingId && value !== 'pending' && value !== 'draft' && value !== 'listing' && value !== 'error';
  });
  return toUnifiedListing({
    ...listing,
    platforms,
    status: listed ? 'active' : listing.status || 'draft',
    lastUpdated: new Date().toISOString(),
  });
}

function extensionTaskFor(platform, listing) {
  return {
    platform,
    createUrl: CREATE_URLS[platform],
    item: {
      id: listing.id,
      title: listing.title,
      description: listing.description || '',
      price: listing.price,
      quantity: listing.quantity || 1,
      images: listing.images || [],
      condition: listing.condition || 'used_good',
      sku: listing.sku || '',
    },
  };
}

async function createEbayListingViaApi(user, listing) {
  const sku = `xl_${String(listing.id).replace(/[^a-zA-Z0-9]/g, '').slice(-12)}_${Date.now().toString(36)}`;
  const imageUrls = (listing.images || []).filter((url) => /^https:\/\//i.test(url));
  await axios.put(
    `${getEbayApiBase()}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      availability: {
        shipToLocationAvailability: {
          quantity: listing.quantity || 1,
        },
      },
      condition: mapEbayCondition(listing.condition),
      product: {
        title: String(listing.title || '').slice(0, 80),
        description: listing.description || listing.title || '',
        imageUrls: imageUrls.length ? imageUrls : undefined,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${user.ebayToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
      },
    }
  );

  const offerResponse = await axios.post(
    `${getEbayApiBase()}/sell/inventory/v1/offer`,
    {
      sku,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: listing.quantity || 1,
      categoryId: listing.ebayCategoryId || undefined,
      pricingSummary: {
        price: {
          value: Number(listing.price || 0).toFixed(2),
          currency: 'USD',
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${user.ebayToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
      },
    }
  );

  const offerId = offerResponse.data?.offerId;
  let listingId = sku;
  let url = `https://www.ebay.com/itm/${sku}`;
  if (offerId) {
    try {
      const published = await axios.post(
        `${getEbayApiBase()}/sell/inventory/v1/offer/${offerId}/publish`,
        {},
        {
          headers: {
            Authorization: `Bearer ${user.ebayToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      listingId = published.data?.listingId || sku;
      url = `https://www.ebay.com/itm/${listingId}`;
    } catch (error) {
      return {
        status: 'listing',
        listingId: sku,
        url,
        needsReview: true,
        error: error.response?.data?.errors?.[0]?.message || error.message,
      };
    }
  }
  return { status: 'active', listingId, url };
}

async function pushListingToStores(listing, user, platforms) {
  const results = [];
  const extensionTasks = [];
  let next = toUnifiedListing(listing);

  for (const store of platforms) {
    const { id: platform, mode } = store;
    if (!mode || mode === 'none') {
      const result = {
        platform,
        status: 'error',
        error: `Connect ${platform} before listing`,
      };
      next = applyPlatformResult(next, platform, result);
      results.push(result);
      continue;
    }

    if (mode === 'demo') {
      const result = {
        platform,
        status: 'active',
        listingId: `demo_${platform}_${next.id}`,
        url: CREATE_URLS[platform],
      };
      next = applyPlatformResult(next, platform, result);
      results.push({ ...result, mode });
      continue;
    }

    if (platform === 'ebay' && mode === 'live') {
      try {
        const result = await createEbayListingViaApi(user, next);
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, platform, mode });
        if (result.status === 'active') continue;
      } catch (error) {
        const message =
          error.response?.data?.errors?.[0]?.message ||
          error.response?.data?.error ||
          error.message ||
          'eBay API listing failed';
        const result = { platform, status: 'listing', error: message, needsReview: true };
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, mode });
      }
    } else {
      const result = { platform, status: 'listing', needsReview: true };
      next = applyPlatformResult(next, platform, result);
      results.push({ ...result, mode });
    }

    extensionTasks.push(extensionTaskFor(platform, next));
  }

  listings.set(next.id, next);
  return { listing: next, results, extensionTasks };
}

function isPlaceholderImportListing(listing) {
  const id = String(listing?.platformListingId || listing?.id || '');
  const image = String(listing?.images?.[0] || '');
  return /^demo[_-]/i.test(id) || /placehold\.co/i.test(image);
}

function ensureConnectedForImport(platform, { mode, account } = {}) {
  const user = getDemoUser();
  const current = getConnectionMode(user, platform);
  if (isRealConnectionMode(current)) return current;

  if (mode === 'extension') {
    if (platform === 'ebay') {
      user.ebayToken = 'extension';
      user.ebayExtension = true;
      user.ebayDemo = false;
      user.ebayAccount = account || 'ebay-browser-session';
    } else if (platform === 'facebook') {
      user.facebookToken = 'extension';
      user.facebookExtension = true;
      user.facebookDemo = false;
      user.facebookAccount = account || 'facebook-browser-session';
    } else if (platform === 'depop') {
      user.depopToken = 'extension';
      user.depopExtension = true;
      user.depopAccount = account || 'depop-browser-session';
    } else if (platform === 'poshmark') {
      user.poshmarkToken = 'extension';
      user.poshmarkExtension = true;
      user.poshmarkDemo = false;
      user.poshmarkPasswordLogin = false;
      user.poshmarkAccount = account || 'poshmark-browser-session';
    } else if (platform === 'etsy') {
      user.etsyToken = 'extension';
      user.etsyExtension = true;
      user.etsyDemo = false;
      user.etsyAccount = account || 'etsy-browser-session';
    }
    persistStore();
    return 'extension';
  }

  const error = new Error(`Connect ${platform} to import listings`);
  error.status = 400;
  throw error;
}

app.get('/api/auth/status', (_req, res) => {
  const user = getDemoUser();
  res.json({
    ebay: {
      connected: Boolean(user.ebayToken),
      mode: getConnectionMode(user, 'ebay'),
      account: user.ebayAccount || null,
    },
    facebook: {
      connected: Boolean(user.facebookToken),
      mode: getConnectionMode(user, 'facebook'),
      account: user.facebookAccount || null,
    },
    depop: {
      connected: Boolean(user.depopToken),
      mode: getConnectionMode(user, 'depop'),
      account: user.depopAccount || null,
    },
    poshmark: {
      connected: Boolean(user.poshmarkToken),
      mode: getConnectionMode(user, 'poshmark'),
      account: user.poshmarkAccount || null,
    },
    etsy: {
      connected: Boolean(user.etsyToken),
      mode: getConnectionMode(user, 'etsy'),
      account: user.etsyAccount || null,
    },
    credentials: {
      ebayLiveMode,
      facebookLiveMode: false,
      facebookRequiresExtension: true,
      depopLiveMode,
      etsyLiveMode,
      googleLiveMode,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
    },
    requiresExtension: false,
  });
});

app.post('/api/auth/connect/extension', (req, res) => {
  const { platform, listings: incoming = [], account } = req.body || {};
  if (!IMPORT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const user = getDemoUser();
  if (platform === 'ebay') {
    user.ebayToken = 'extension';
    user.ebayExtension = true;
    user.ebayDemo = false;
    user.ebayAccount = account || 'ebay-browser-session';
  } else if (platform === 'facebook') {
    user.facebookToken = 'extension';
    user.facebookExtension = true;
    user.facebookDemo = false;
    user.facebookAccount = account || 'facebook-browser-session';
  } else if (platform === 'depop') {
    user.depopToken = 'extension';
    user.depopExtension = true;
    user.depopAccount = account || 'depop-browser-session';
  } else if (platform === 'poshmark') {
    user.poshmarkToken = 'extension';
    user.poshmarkExtension = true;
    user.poshmarkDemo = false;
    user.poshmarkPasswordLogin = false;
    user.poshmarkAccount = account || 'poshmark-browser-session';
  } else if (platform === 'etsy') {
    user.etsyToken = 'extension';
    user.etsyExtension = true;
    user.etsyDemo = false;
    user.etsyAccount = account || 'etsy-browser-session';
  }

  persistStore();

  incoming.forEach((listing) => {
    if (!listing?.title && !listing?.id) return;
    upsertImportedListing(listing);
  });

  return res.json({
    connected: true,
    mode: 'extension',
    imported: incoming.length,
  });
});

function oauthConnectResponse(platform, liveMode, redirect) {
  if (liveMode) {
    return { connected: false, mode: 'live', redirect };
  }
  return {
    connected: false,
    needsOAuthCredentials: true,
    message: `Add ${platform} OAuth credentials to .env.`,
  };
}

app.post('/api/auth/connect/ebay', (_req, res) => {
  return res.json(oauthConnectResponse('eBay', ebayLiveMode, '/api/auth/ebay/live'));
});

app.post('/api/auth/connect/facebook', (_req, res) => {
  return res.json({
    connected: false,
    requiresExtension: true,
    message: 'Facebook Marketplace connects with the Chrome extension.',
  });
});

app.post('/api/auth/connect/depop', (_req, res) => {
  return res.json(oauthConnectResponse('Depop', depopLiveMode, '/api/auth/depop/live'));
});

app.post('/api/auth/connect/etsy', (_req, res) => {
  return res.json(oauthConnectResponse('Etsy', etsyLiveMode, '/api/auth/etsy/live'));
});

app.post('/api/auth/connect/poshmark', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const session = await loginToPoshmark(email, password);
    const user = getDemoUser();
    user.poshmarkToken = session.token;
    user.poshmarkRefreshToken = session.refreshToken || null;
    user.poshmarkDemo = false;
    user.poshmarkExtension = false;
    user.poshmarkPasswordLogin = true;
    user.poshmarkAccount = session.username || email;
    persistStore();
    return res.json({
      connected: true,
      mode: 'password',
      account: user.poshmarkAccount,
    });
  } catch (error) {
    logError('Poshmark sign-in', error, { req });
    const status = error.status === 401 ? 401 : 502;
    return res.status(status).json({
      error: error.message || 'Poshmark sign-in failed',
      canUseExtension: true,
    });
  }
});

app.post('/api/auth/connect/demo', (req, res) => {
  const { platform } = req.body || {};
  if (platform === 'ebay') {
    connectDemoEbay();
    return res.json({ connected: true, mode: 'demo' });
  }
  if (platform === 'facebook') {
    connectDemoFacebook();
    return res.json({ connected: true, mode: 'demo' });
  }
  return res.status(400).json({ error: 'platform required' });
});

app.post('/api/auth/disconnect', (req, res) => {
  const { platform } = req.body || {};
  if (!IMPORT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const user = getDemoUser();
  if (platform === 'ebay') {
    delete user.ebayToken;
    delete user.ebayRefreshToken;
    delete user.ebayTokenExpires;
    delete user.ebayDemo;
    delete user.ebayExtension;
    delete user.ebayAccount;
  } else if (platform === 'facebook') {
    delete user.facebookToken;
    delete user.facebookTokenExpires;
    delete user.facebookPages;
    delete user.facebookDemo;
    delete user.facebookExtension;
    delete user.facebookAccount;
  } else if (platform === 'depop') {
    delete user.depopToken;
    delete user.depopDemo;
    delete user.depopExtension;
    delete user.depopAccount;
    delete user.depopRefreshToken;
    delete user.depopTokenExpires;
  } else if (platform === 'poshmark') {
    delete user.poshmarkToken;
    delete user.poshmarkRefreshToken;
    delete user.poshmarkDemo;
    delete user.poshmarkExtension;
    delete user.poshmarkPasswordLogin;
    delete user.poshmarkAccount;
  } else if (platform === 'etsy') {
    delete user.etsyToken;
    delete user.etsyRefreshToken;
    delete user.etsyTokenExpires;
    delete user.etsyDemo;
    delete user.etsyExtension;
    delete user.etsyAccount;
    delete user.etsyUserId;
    delete user.etsyShopId;
  }

  persistStore();
  return res.json({ connected: false, platform, mode: 'none' });
});

// ======================
// EBAY AUTHENTICATION
// ======================

// Initiate eBay OAuth flow (browser navigation)
app.get('/api/auth/ebay', (req, res) => {
  if (!ebayLiveMode) {
    return res.redirect('/dashboard.html?oauthError=ebay#marketplaces');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/ebay/live');
});

app.get('/api/auth/ebay/live', (req, res) => {
  const state = beginOAuth(req, res, 'ebay');
  if (!state) return;
  const authUrl = `${getEbayAuthBase()}/oauth2/authorize?` +
    new URLSearchParams({
      client_id: process.env.EBAY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.EBAY_REDIRECT_URI,
      scope: process.env.EBAY_SCOPES || 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account',
      state: state
    });
  // Do not set prompt=login. Production eBay sign-in includes Continue with Google.
  
  res.redirect(authUrl);
});

// Handle eBay OAuth callback
app.get('/api/auth/ebay/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=ebay#marketplaces');
  }
  
  try {
    // Exchange authorization code for access token
    const tokenResponse = await axios.post(`${getEbayApiBase()}/identity/v1/oauth2/token`, 
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.EBAY_REDIRECT_URI
      }), {
        auth: {
          username: process.env.EBAY_CLIENT_ID,
          password: process.env.EBAY_CLIENT_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const userData = oauthResult.user;
    Object.assign(userData, {
      ebayToken: access_token,
      ebayRefreshToken: refresh_token,
      ebayTokenExpires: Date.now() + (expires_in * 1000),
      ebayDemo: false,
      ebayExtension: false,
      ebayAccount: 'ebay-oauth',
    });
    userStore.saveUser(userData);
    
    res.redirect('/dashboard.html?connected=ebay#marketplaces');
  } catch (error) {
    logError('eBay OAuth', error, { req });
    res.status(500).send('Authentication failed');
  }
});

// ======================
// FACEBOOK MARKETPLACE
// Facebook Marketplace has no public listing OAuth API.
// Connect happens through the Chrome extension.
// ======================

app.get(['/api/auth/facebook', '/api/auth/facebook/live', '/api/auth/facebook/callback'], (req, res) => {
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/dashboard.html?connect=facebook-extension#marketplaces');
});

// ======================
// DEPOP AUTHENTICATION
// ======================

function getDepopAuthUrl() {
  return String(process.env.DEPOP_AUTH_URL || 'https://www.depop.com/settings/oauth/apps/').replace(/\/?$/, '/');
}

function getDepopTokenUrl() {
  return process.env.DEPOP_TOKEN_URL || 'https://partnerapi.depop.com/api/v1/oauth2/access-token/';
}

function getDepopRedirectUri() {
  return process.env.DEPOP_REDIRECT_URI || `${BASE_URL}/api/auth/depop/callback`;
}

function getDepopScopes() {
  const raw = process.env.DEPOP_SCOPES || 'products_read products_write shop_read orders_read';
  return raw.trim().split(/[\s+]+/).filter(Boolean).join('+');
}

app.get('/api/auth/depop', (req, res) => {
  if (!depopLiveMode) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/depop/live');
});

app.get('/api/auth/depop/live', (req, res) => {
  const pkce = createPkce();
  const state = beginOAuth(req, res, 'depop', { verifier: pkce.verifier });
  if (!state) return;
  const authUrl = `${getDepopAuthUrl()}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: process.env.DEPOP_CLIENT_ID,
      redirect_uri: getDepopRedirectUri(),
      scope: getDepopScopes(),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
  res.redirect(authUrl);
});

app.get('/api/auth/depop/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }
  const pkce = oauthResult.oauth.extra;
  if (!pkce?.verifier) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }

  try {
    const tokenResponse = await axios.post(
      getDepopTokenUrl(),
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: process.env.DEPOP_CLIENT_ID,
        client_secret: process.env.DEPOP_CLIENT_SECRET,
        redirect_uri: getDepopRedirectUri(),
        code_verifier: pkce.verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const userData = oauthResult.user;
    Object.assign(userData, {
      depopToken: access_token,
      depopRefreshToken: refresh_token,
      depopTokenExpires: expires_in ? Date.now() + (expires_in * 1000) : null,
      depopDemo: false,
      depopExtension: false,
      depopAccount: 'depop-oauth',
    });
    userStore.saveUser(userData);

    res.redirect('/dashboard.html?connected=depop#marketplaces');
  } catch (depopError) {
    logError('Depop OAuth', depopError, { req });
    res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }
});

// ======================
// POSHMARK PASSWORD LOGIN
// ======================

function poshmarkError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loginToPoshmark(email, password) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://poshmark.com',
    Referer: 'https://poshmark.com/login',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };
  const endpoints = [
    'https://poshmark.com/vm-rest/auth/users/access_token',
    'https://poshmark.com/auth/users/access_token',
  ];

  let lastNetworkError = null;
  for (const url of endpoints) {
    try {
      const response = await axios.post(
        url,
        { username: email, password },
        { headers, timeout: 15000, validateStatus: () => true }
      );
      const data = response.data || {};
      const token = data.token || data.access_token || data.jwt || data.id_token;
      if (response.status >= 200 && response.status < 300 && token) {
        return {
          token,
          refreshToken: data.refresh_token || null,
          username: data.username || data.user?.username || data.user?.email || email,
        };
      }
      if (response.status === 400 || response.status === 401) {
        const message =
          data.errorMessage ||
          data.error_message ||
          data.message ||
          data.error ||
          'Invalid Poshmark email or password';
        throw poshmarkError(typeof message === 'string' ? message : 'Invalid Poshmark email or password', 401);
      }
    } catch (error) {
      if (error.status === 401) throw error;
      logError('Poshmark login endpoint', error, { detail: { url } });
      lastNetworkError = error;
    }
  }

  throw poshmarkError(
    lastNetworkError?.message
      ? `Poshmark sign-in failed (${lastNetworkError.message}). Try the Chrome extension.`
      : 'Poshmark sign-in failed. Check your email and password, or connect with the Chrome extension.',
    502
  );
}

// ======================
// ETSY OAUTH
// ======================

function getEtsyRedirectUri() {
  return process.env.ETSY_REDIRECT_URI || `${BASE_URL}/api/auth/etsy/callback`;
}

function getEtsyScopes() {
  return process.env.ETSY_SCOPES || 'listings_r listings_w shops_r shops_w transactions_r';
}

function etsyApiHeaders(accessToken) {
  return {
    'x-api-key': getEtsyApiKey(),
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

app.get('/api/auth/etsy', (req, res) => {
  if (!etsyLiveMode) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/etsy/live');
});

app.get('/api/auth/etsy/live', (req, res) => {
  if (!etsyLiveMode) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
  const pkce = createPkce();
  const state = beginOAuth(req, res, 'etsy', { verifier: pkce.verifier });
  if (!state) return;
  const authUrl =
    'https://www.etsy.com/oauth/connect?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: getEtsyApiKey(),
      redirect_uri: getEtsyRedirectUri(),
      scope: getEtsyScopes(),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
  res.redirect(authUrl);
});

app.get('/api/auth/etsy/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
  const pkce = oauthResult.oauth.extra;
  if (!pkce?.verifier) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }

  try {
    const tokenResponse = await axios.post(
      'https://api.etsy.com/v3/public/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: getEtsyApiKey(),
        redirect_uri: getEtsyRedirectUri(),
        code: String(code),
        code_verifier: pkce.verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    let account = 'etsy-oauth';
    let userId = null;
    let shopId = null;
    try {
      const me = await axios.get('https://api.etsy.com/v3/application/users/me', {
        headers: etsyApiHeaders(access_token),
      });
      userId = me.data.user_id || me.data.userId || null;
      account = me.data.login_name || me.data.primary_email || account;
      if (userId) {
        const shops = await axios.get(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
          headers: etsyApiHeaders(access_token),
        });
        const shop = shops.data?.shop_id
          ? shops.data
          : shops.data?.results?.[0] || shops.data?.shops?.[0];
        shopId = shop?.shop_id || shop?.shopId || null;
        account = shop?.shop_name || account;
      }
    } catch (profileError) {
      logError('Etsy profile lookup', profileError, { req });
    }

    const userData = oauthResult.user;
    Object.assign(userData, {
      etsyToken: access_token,
      etsyRefreshToken: refresh_token,
      etsyTokenExpires: expires_in ? Date.now() + expires_in * 1000 : null,
      etsyDemo: false,
      etsyExtension: false,
      etsyAccount: account,
      etsyUserId: userId,
      etsyShopId: shopId,
    });
    userStore.saveUser(userData);

    res.redirect('/dashboard.html?connected=etsy#marketplaces');
  } catch (oauthError) {
    logError('Etsy OAuth', oauthError, { req });
    res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
});

function mapEtsyListing(listing) {
  const images = [];
  if (listing.images?.[0]?.url_570xN) images.push(listing.images[0].url_570xN);
  else if (listing.MainImage?.url_570xN) images.push(listing.MainImage.url_570xN);
  else if (listing.image_urls?.[0]) images.push(listing.image_urls[0]);
  const price = parseListingPrice(listing.price);
  return {
    title: listing.title || 'Untitled Item',
    description: listing.description || '',
    price,
    quantity: listing.quantity || 1,
    images,
    platform: 'etsy',
    platformListingId: String(listing.listing_id || listing.listingId || listing.id),
    status: listing.state === 'active' ? 'active' : listing.state || 'active',
    url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}`,
  };
}

async function fetchLiveEtsyCandidates(user) {
  if (!user.etsyToken || user.etsyDemo || user.etsyExtension) return [];
  let shopId = user.etsyShopId;
  if (!shopId) {
    const me = await axios.get('https://api.etsy.com/v3/application/users/me', {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const userId = me.data.user_id || me.data.userId;
    const shops = await axios.get(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const shop = shops.data?.shop_id ? shops.data : shops.data?.results?.[0] || shops.data?.shops?.[0];
    shopId = shop?.shop_id || shop?.shopId;
    if (shopId) {
      user.etsyShopId = shopId;
      persistStore();
    }
  }
  if (!shopId) return [];

  const response = await axios.get(
    `https://api.etsy.com/v3/application/shops/${shopId}/listings/active`,
    {
      headers: etsyApiHeaders(user.etsyToken),
      params: { limit: 50, includes: 'Images' },
    }
  );
  const results = response.data.results || response.data.listings || [];
  return results.map(mapEtsyListing);
}

// ======================
// LISTING ENDPOINTS
// ======================

// Get user's listings from eBay
app.get('/api/listings/ebay', async (req, res) => {
  try {
    const userData = getDemoUser();
    
    if (!userData || !userData.ebayToken) {
      return res.status(401).json({ error: 'Not authenticated with eBay' });
    }

    if (userData.ebayDemo) {
      const demoListings = seedDemoEbayListings();
      return res.json(demoListings);
    }

    if (userData.ebayExtension) {
      const extensionListings = Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'ebay'));
      return res.json(extensionListings);
    }
    
    // Fetch active listings from eBay Inventory + Offer APIs
    const ebayListings = (await fetchLiveEbayCandidates(userData)).map((item) =>
      upsertImportedListing(item)
    );

    res.json(ebayListings);
  } catch (error) {
    logError('eBay listings fetch', error, { req });
    res.status(500).json({ error: 'Failed to fetch eBay listings' });
  }
});

// Get user's listings from Facebook Marketplace
app.get('/api/listings/facebook', async (req, res) => {
  try {
    const userData = getDemoUser();
    
    if (!userData || !userData.facebookToken) {
      return res.status(401).json({ error: 'Not authenticated with Facebook' });
    }

    if (userData.facebookDemo) {
      const demoListings = seedDemoFacebookListings();
      return res.json(demoListings);
    }

    if (userData.facebookExtension) {
      const extensionListings = Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'facebook'));
      return res.json(extensionListings);
    }
    
    // Get user's pages
    const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: userData.facebookToken
      }
    });
    
    if (!pagesResponse.data.data.length) {
      return res.json([]); // No pages, return empty listings
    }
    
    // Use the first page for simplicity
    const pageAccessToken = pagesResponse.data.data[0].access_token;
    
    // Fetch products from Facebook Catalog (simplified - in reality would need catalog setup)
    // For demo, we'll return mock data or try to fetch from a test catalog
    try {
      const catalogResponse = await axios.get('https://graph.facebook.com/v18.0/me/product_catalogs', {
        params: {
          access_token: pageAccessToken
        }
      });
      
      if (catalogResponse.data.data.length) {
        const catalogId = catalogResponse.data.data[0].id;
        const productsResponse = await axios.get(`https://graph.facebook.com/v18.0/${catalogId}/products`, {
          params: {
            access_token: pageAccessToken,
            fields: 'id,title,description,price,image_url,availability,quantity'
          }
        });
        
        const facebookListings = (productsResponse.data.data || []).map((product) =>
          upsertImportedListing(mapFacebookCatalogProduct(product))
        );

        res.json(facebookListings);
      } else {
        // No catalog, return empty array for demo
        res.json([]);
      }
    } catch (catalogError) {
      // If catalog access fails, return mock data for demo purposes
      logError('Facebook catalog access', catalogError, { req });
      
      const mockListings = seedDemoInventory();
      res.json(mockListings);
    }
  } catch (error) {
    logError('Facebook listings fetch', error, { req });
    res.status(500).json({ error: 'Failed to fetch Facebook listings' });
  }
});

app.get('/api/listings/depop', (_req, res) => {
  const userData = getDemoUser();
  if (!userData.depopToken) {
    return res.status(401).json({ error: 'Not authenticated with Depop' });
  }
  const depopListings = Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'depop'));
  return res.json(depopListings);
});

app.get('/api/listings/poshmark', (_req, res) => {
  const userData = getDemoUser();
  if (!userData.poshmarkToken) {
    return res.status(401).json({ error: 'Not authenticated with Poshmark' });
  }
  return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'poshmark')));
});

app.get('/api/listings/etsy', async (_req, res) => {
  const userData = getDemoUser();
  if (!userData.etsyToken) {
    return res.status(401).json({ error: 'Not authenticated with Etsy' });
  }
  if (userData.etsyDemo) {
    return res.json(buildEtsyMarketplaceCandidates(new Date().toISOString()));
  }
  if (userData.etsyExtension) {
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'etsy')));
  }
  try {
    const candidates = await fetchLiveEtsyCandidates(userData);
    return res.json(candidates);
  } catch (error) {
    logError('Etsy listings fetch', error, { req });
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'etsy')));
  }
});

app.get('/api/listings/import/candidates', async (req, res) => {
  const platform = String(req.query.platform || '');
  if (!IMPORT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const user = getDemoUser();
  const mode = getConnectionMode(user, platform);

  if (!isRealConnectionMode(mode)) {
    return res.json({
      platform,
      connected: false,
      mode: 'none',
      candidates: [],
    });
  }

  let candidates = [];
  let source = mode;

  if (mode === 'live' && platform === 'ebay' && user.ebayToken) {
    try {
      candidates = await fetchLiveEbayCandidates(user);
      source = 'live';
    } catch (error) {
      logError('eBay import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch eBay listings' });
    }
  } else if (mode === 'live' && platform === 'facebook' && user.facebookToken) {
    try {
      candidates = await fetchLiveFacebookCandidates(user);
      source = 'live';
    } catch (error) {
      logError('Facebook import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch Facebook listings' });
    }
  } else if (mode === 'live' && platform === 'etsy' && user.etsyToken) {
    try {
      candidates = await fetchLiveEtsyCandidates(user);
      source = 'live';
    } catch (error) {
      logError('Etsy import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch Etsy listings' });
    }
  }

  return res.json({
    platform,
    connected: true,
    mode: source,
    candidates: annotateImportCandidates(candidates, platform),
  });
});

app.post('/api/listings/import', async (req, res) => {
  const { platform, listings: incoming = [], mode, account } = req.body || {};
  if (!IMPORT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return res.status(400).json({ error: 'Select at least one listing to import' });
  }

  let connectionMode;
  try {
    connectionMode = ensureConnectedForImport(platform, { mode, account });
  } catch (error) {
    logError('Import connection check', error, { req });
    return res.status(error.status || 400).json({ error: error.message });
  }
  const created = [];
  const merged = [];
  const skipped = [];

  incoming.forEach((raw) => {
    const listing = { ...raw, platform: raw.platform || platform };
    if (isPlaceholderImportListing(listing)) {
      skipped.push({
        title: listing.title,
        reason: 'placeholder listing',
      });
      return;
    }
    const existing = findExistingListing(listing);
    const incomingPrice = parseListingPrice(listing.price);
    const shouldRefresh =
      existing &&
      listingHasPlatform(existing, platform) &&
      ((incomingPrice > 0 && incomingPrice !== parseListingPrice(existing.price)) ||
        (realListingImages(listing.images).length && !realListingImages(existing.images).length) ||
        (listing.description && !existing.description) ||
        (listing.title && listing.title !== existing.title && incomingPrice > 0));
    if (existing && listingHasPlatform(existing, platform) && !shouldRefresh) {
      skipped.push({
        id: existing.id,
        title: existing.title,
        reason: 'already imported',
      });
      return;
    }
    const result = upsertImportedListing(listing);
    if (existing) merged.push(result);
    else created.push(result);
  });

  const saved = [...created, ...merged];
  mergeObviousDuplicateListings();
  cleanStoredListingTitles();
  await hydrateMissingListingImages(saved.map((listing) => listings.get(listing.id) || listing));

  return res.json({
    platform,
    mode: connectionMode,
    imported: created.length + merged.length,
    created: created.length,
    merged: merged.length,
    skipped: skipped.length,
    listings: saved.map((listing) => toUnifiedListing(listings.get(listing.id) || listing)),
    skippedListings: skipped,
    imageMatches: findImageMatchGroups(),
  });
});

// Get all listings (combined)
app.get('/api/listings', async (_req, res) => {
  try {
    const userData = getDemoUser();
    if (userData.ebayToken) {
      if (userData.ebayDemo && listings.size === 0) seedDemoEbayListings();
      else if (userData.ebayExtension) {
        // Listings already imported from extension scrape.
      } else {
        try {
          (await fetchLiveEbayCandidates(userData)).forEach((item) => {
            upsertImportedListing(item);
          });
        } catch (error) {
          logError('Live eBay sync', error, { req });
        }
      }
    }
    if (userData.facebookToken) {
      if (userData.facebookDemo && listings.size === 0) seedDemoFacebookListings();
      else if (userData.facebookExtension) {
        // Listings already imported from extension scrape.
      }
    }
    mergeObviousDuplicateListings();
    cleanStoredListingTitles();
    await hydrateMissingListingImages();
    res.json(Array.from(listings.values()).map(toUnifiedListing));
  } catch (error) {
    logError('Combined listings fetch', error, { req });
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

app.get('/api/listings/image-matches', (req, res) => {
  getDemoUser();
  mergeObviousDuplicateListings();
  cleanStoredListingTitles();
  return res.json({
    groups: findImageMatchGroups(),
    dismissedPairKeys: userStore.listImageMatchDismissals(getCurrentUser()?.id),
  });
});

app.post('/api/listings/image-matches/resolve', (req, res) => {
  try {
    const user = getDemoUser();
    const { primaryId, matchIds = [], decision } = req.body || {};
    if (decision !== 'merge' && decision !== 'dismiss') {
      return res.status(400).json({ error: 'Decision must be merge or dismiss' });
    }

    const groupIds = [primaryId, ...matchIds].filter(Boolean);
    if (groupIds.length < 2) {
      return res.status(400).json({ error: 'Select at least two listings' });
    }

    if (decision === 'dismiss') {
      const pairKeys = [];
      for (let i = 0; i < groupIds.length; i += 1) {
        for (let j = i + 1; j < groupIds.length; j += 1) {
          pairKeys.push(userStore.imageMatchPairKey(groupIds[i], groupIds[j]));
        }
      }
      userStore.dismissImageMatchPairs(user.id, pairKeys);
      return res.json({
        decision: 'dismiss',
        groups: findImageMatchGroups(),
      });
    }

    const primary = listings.get(primaryId);
    if (!primary) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = mergeInventoryListings(primaryId, matchIds);
    return res.json({
      decision: 'merge',
      listing: toUnifiedListing(result.listing),
      mergedIds: result.mergedIds,
      groups: findImageMatchGroups(),
    });
  } catch (error) {
    logError('Image match resolve', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Failed to save match decision' });
  }
});

async function applyListingUpdates(listing, updates, userData) {
  const { platforms: platformUpdates, ...safeUpdates } = updates || {};
  let nextPlatforms = platformUpdates
    ? { ...getPlatforms(listing), ...platformUpdates }
    : getPlatforms(listing);
  if (safeUpdates.price !== undefined) {
    const nextPrice = parseListingPrice(safeUpdates.price);
    nextPlatforms = Object.fromEntries(
      Object.entries(nextPlatforms).map(([platform, entry]) => [
        platform,
        { ...entry, price: nextPrice },
      ])
    );
  }
  const updatedListing = toUnifiedListing({
    ...listing,
    ...safeUpdates,
    platforms: nextPlatforms,
    lastUpdated: new Date().toISOString(),
  });
  listings.set(listing.id, updatedListing);

  const platforms = getPlatforms(updatedListing);
  if (safeUpdates.price !== undefined) {
    await pushLiveMarketplacePrice(updatedListing, platforms, userData);
  }

  return updatedListing;
}

function isLiveMarketplaceId(id) {
  const value = String(id || '');
  return Boolean(value) && !/^(demo_|local_|item_)/i.test(value);
}

async function pushLiveMarketplacePrice(listing, platforms, userData) {
  const ebayId = platforms.ebay?.listingId;
  if (
    isLiveMarketplaceId(ebayId) &&
    userData.ebayToken &&
    !userData.ebayDemo &&
    !userData.ebayExtension
  ) {
    try {
      await updateEbayListing(ebayId, listing, userData.ebayToken);
    } catch (error) {
      logError('eBay price push', error);
    }
  }

  const etsyId = platforms.etsy?.listingId;
  if (
    isLiveMarketplaceId(etsyId) &&
    userData.etsyToken &&
    !userData.etsyDemo &&
    !userData.etsyExtension
  ) {
    try {
      await updateEtsyListingPrice(etsyId, listing.price, userData);
    } catch (error) {
      logError('Etsy price push', error);
    }
  }
}

app.post(
  '/api/uploads',
  express.raw({ type: () => true, limit: '10mb' }),
  (req, res) => {
    const user = getDemoUser();
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    if (body.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image must be 10MB or smaller' });
    }
    const mime = String(req.headers['content-type'] || 'application/octet-stream');
    if (mime.startsWith('application/json')) {
      return res.status(400).json({ error: 'Send the image as a file, not JSON' });
    }
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'photo.jpg'));
    const owner = safeUserId(user.id);
    const dir = path.join(UPLOADS_DIR, owner);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${uuidv4()}.${extFromMime(mime, filename)}`;
    fs.writeFileSync(path.join(dir, name), body);
    const url = `/uploads/${owner}/${name}`;
    return res.status(201).json({ url, filename: name });
  }
);

app.post('/api/listings', (req, res) => {
  const { title, description, price, quantity, images, platforms: requestedPlatforms, sku, condition } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const userData = getDemoUser();
  const parsedPrice = parseListingPrice(price);
  const imageList = persistListingImages(userData.id, images || []);
  const stores = requestedPushPlatforms(userData, requestedPlatforms);
  const targetStores = stores.length ? stores : IMPORT_PLATFORMS.map((id) => ({ id, mode: 'none' }));
  const platforms = {};
  for (const store of targetStores) {
    platforms[store.id] = pendingPlatformEntry(
      { price: parsedPrice, images: imageList },
      store.id,
      { status: 'pending' }
    );
  }

  const item = toUnifiedListing({
    id: `item_${uuidv4()}`,
    title: String(title).trim(),
    description: description || '',
    price: parsedPrice,
    quantity: quantity === undefined || quantity === '' ? 1 : parseInt(quantity, 10) || 0,
    images: imageList,
    sku: sku ? String(sku).trim() : '',
    condition: condition || 'used_good',
    status: 'draft',
    platforms,
    lastUpdated: new Date().toISOString(),
  });
  listings.set(item.id, item);
  return res.status(201).json(item);
});

app.post('/api/listings/:id/push', async (req, res) => {
  try {
    const user = getDemoUser();
    const listing = listings.get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const platforms = requestedPushPlatforms(user, req.body?.platforms);
    if (!platforms.length) {
      return res.status(400).json({
        error: 'Connect at least one marketplace before listing this item',
      });
    }

    const pushed = await pushListingToStores(listing, user, platforms);
    recordActivity('success', `Pushed "${listing.title}" to ${platforms.map((store) => store.id).join(', ')}`, {
      source: 'server',
      listingId: listing.id,
      results: pushed.results,
    });
    return res.json({
      listing: pushed.listing,
      results: pushed.results,
      extensionTasks: pushed.extensionTasks,
    });
  } catch (error) {
    console.error('Push listing failed:', error.response?.data || error.message);
    return res.status(error.status || 500).json({ error: error.message || 'Failed to list item' });
  }
});

app.post('/api/listings/:id/listed', (req, res) => {
  const listing = listings.get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  const incoming = Array.isArray(req.body?.results) ? req.body.results : [req.body];
  let next = toUnifiedListing(listing);
  for (const result of incoming) {
    const platform = String(result?.platform || '').toLowerCase();
    if (!IMPORT_PLATFORMS.includes(platform)) continue;
    next = applyPlatformResult(next, platform, result);
  }
  listings.set(next.id, next);
  recordActivity('info', `Listing results saved for "${next.title}"`, {
    source: req.body?.source || 'extension',
    listingId: next.id,
    results: incoming,
  });
  return res.json({ listing: next });
});

app.patch('/api/listings/bulk', async (req, res) => {
  try {
    const { ids, updates } = req.body;
    const userData = getDemoUser();
    const results = [];

    for (const id of ids || []) {
      try {
        const listing = listings.get(id);
        if (!listing) {
          results.push({ id, success: false, error: 'Listing not found' });
          continue;
        }
        const updatedListing = await applyListingUpdates(listing, updates, userData);
        results.push({ id, success: true, listing: updatedListing });
      } catch (error) {
        logError('Bulk listing update', error, { req, detail: { listingId: id } });
        results.push({ id, success: false, error: error.message });
      }
    }

    res.json({
      results,
      facebookListings: results
        .filter((r) => r.success)
        .map((r) => facebookPushListing(r.listing))
        .filter(Boolean),
    });
  } catch (error) {
    logError('Bulk update', error, { req });
    res.status(500).json({ error: 'Failed to perform bulk update' });
  }
});

app.post('/api/listings/adjust-prices', async (req, res) => {
  const percent = Number(req.body?.percent ?? -10);
  if (Number.isNaN(percent) || percent <= -100) {
    return res.status(400).json({ error: 'Invalid percent value' });
  }

  const requestedIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const multiplier = 1 + percent / 100;
  const updated = [];
  const userData = getDemoUser();

  for (const listing of listings.values()) {
    if (requestedIds && !requestedIds.includes(listing.id)) continue;

    const oldPrice = Number(listing.price) || 0;
    const newPrice = Math.max(0.01, Math.round(oldPrice * multiplier * 100) / 100);
    const updatedListing = await applyListingUpdates(
      listing,
      { price: newPrice, previousPrice: oldPrice },
      userData
    );
    updated.push(updatedListing);
  }

  return res.json({
    percent,
    count: updated.length,
    listings: updated,
    facebookListings: updated.map(facebookPushListing).filter(Boolean),
  });
});

app.patch('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const userData = getDemoUser();

    const listing = listings.get(id);
    if (!listing) {
      return res.status(404).send('Listing not found');
    }

    const updatedListing = await applyListingUpdates(listing, updates, userData);
    res.json(updatedListing);
  } catch (error) {
    logError('Listing update', error, { req });
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// Helper function to update eBay listing
async function updateEbayListing(listingId, listingData, accessToken) {
  const ebayId = String(listingId || '').replace(/^ebay_/, '');
  if (!/^\d{9,13}$/.test(ebayId)) {
    throw new Error('Missing eBay item id');
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <InventoryStatus>
    <ItemID>${ebayId}</ItemID>
    <StartPrice>${Number(listingData.price).toFixed(2)}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

  const response = await axios.post(`${getEbayApiBase()}/ws/api.dll`, xml, {
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
  });
  const text = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (/<Ack>Failure<\/Ack>|<Ack>PartialFailure<\/Ack>/i.test(text)) {
    const msg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] || 'eBay price revise failed';
    throw new Error(msg);
  }
}

async function updateEtsyListingPrice(listingId, price, userData) {
  const headers = etsyApiHeaders(userData.etsyToken);
  const inventory = await axios.get(
    `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
    { headers }
  );
  const products = (inventory.data.products || []).map((product) => ({
    sku: product.sku,
    property_values: product.property_values || [],
    offerings: (product.offerings || []).map((offering) => ({
      price: Number(price),
      quantity: offering.quantity,
      is_enabled: offering.is_enabled !== false,
    })),
  }));
  await axios.put(
    `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
    {
      products,
      price_on_property: inventory.data.price_on_property || [],
      quantity_on_property: inventory.data.quantity_on_property || [],
      sku_on_property: inventory.data.sku_on_property || [],
    },
    { headers }
  );
}

// Helper function to update Facebook listing
async function updateFacebookListing(listingId, listingData, accessToken) {
  // Extract the actual Facebook ID from our ID format
  const fbId = listingId.replace('fb_', '');
  
  // Get user's pages to get page access token
  const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: {
      access_token: accessToken
    }
  });
  
  if (!pagesResponse.data.data.length) {
    throw new Error('No Facebook pages found');
  }
  
  const pageAccessToken = pagesResponse.data.data[0].access_token;
  
  // Update the product (assuming it's in a product catalog)
  // Note: This requires the item to be in a Facebook product catalog
  // For a real implementation, you'd need to create/add to a catalog first
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${fbId}`, 
      {
        title: listingData.title || '',
        description: listingData.description || '',
        price: listingData.price || 0,
        quantity: listingData.quantity || 0,
        // Note: Image updates would require uploading new images first
        image_url: listingData.images?.[0] || '',
        availability: listingData.quantity > 0 ? 'in_stock' : 'out_of_stock',
        condition: 'NEW'
      },
      {
        params: {
          access_token: pageAccessToken
        }
      }
    );
  } catch (error) {
    // If direct product update fails (likely due to not being in a catalog),
    // we'll note that but not fail the entire operation
    logError('Facebook product update', error);
    // In a real app, you might need to handle this differently
  }
}

// Create a new listing on eBay
app.post('/api/listings/ebay', async (req, res) => {
  try {
    const { title, description, price, quantity, images } = req.body;
    const userData = getDemoUser();
    
    if (!userData || !userData.ebayToken) {
      return res.status(401).send('Not authenticated with eBay');
    }
    
    // Create inventory item
    const sku = `crosslist_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const inventoryResponse = await axios.post(`${getEbayApiBase()}/sell/inventory/v1/inventory_item/${sku}`,
      {
        availability: {
          shipToLocationAvailability: {
            quantity: quantity || 0
          }
        },
        product: {
          title: title || '',
          description: description || '',
          imageUrls: images || []
        }
      },
      {
        headers: {
          Authorization: `Bearer ${userData.ebayToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Create offer
    const offerResponse = await axios.post(`${getEbayApiBase()}/sell/inventory/v1/offer`,
      {
        sku: sku,
        marketplaceId: 'EBAY_US',
        format: 'FIXED_PRICE',
        availableQuantity: quantity || 0,
        pricingSummary: {
          price: {
            value: price?.toString() || '0',
            currency: 'USD'
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${userData.ebayToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const listingId = `ebay_${sku}`;
    const newListing = {
      id: listingId,
      title,
      description,
      price: parseFloat(price || 0),
      quantity: quantity || 0,
      images: images || [],
      platform: 'ebay',
      platformListingId: sku,
      status: 'active',
      lastUpdated: new Date().toISOString()
    };
    
    listings.set(listingId, newListing);
    
    res.status(201).json(newListing);
  } catch (error) {
    logError('Create eBay listing', error, { req });
    res.status(500).json({ error: 'Failed to create eBay listing' });
  }
});

// Create a new listing on Facebook (simplified - creates a product in catalog)
app.post('/api/listings/facebook', async (req, res) => {
  try {
    const { title, description, price, quantity, images } = req.body;
    const userData = getDemoUser();
    
    if (!userData || !userData.facebookToken) {
      return res.status(401).send('Not authenticated with Facebook');
    }
    
    // Get user's pages
    const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: userData.facebookToken
      }
    });
    
    if (!pagesResponse.data.data.length) {
      return res.status(400).send('No Facebook pages found');
    }
    
    const pageAccessToken = pagesResponse.data.data[0].access_token;
    
    // Get product catalogs
    const catalogsResponse = await axios.get('https://graph.facebook.com/v18.0/me/product_catalogs', {
      params: {
        access_token: pageAccessToken
      }
    });
    
    if (!catalogsResponse.data.data.length) {
      return res.status(400).send('No product catalog found. Please create a catalog first.');
    }
    
    const catalogId = catalogsResponse.data.data[0].id;
    
    // Create product in catalog
    const productResponse = await axios.post(`https://graph.facebook.com/v18.0/${catalogId}/products`,
      {
        title: title || '',
        description: description || '',
        price: price?.toString() || '0',
        quantity: quantity || 0,
        // Note: Image handling would require uploading to Facebook first
        image_url: images && images.length > 0 ? images[0] : '',
        availability: quantity > 0 ? 'in_stock' : 'out_of_stock',
        condition: 'NEW'
      },
      {
        params: {
          access_token: pageAccessToken
        }
      }
    );
    
    const listingId = `fb_${productResponse.data.id}`;
    const newListing = {
      id: listingId,
      title,
      description,
      price: parseFloat(price || 0),
      quantity: quantity || 0,
      images: images || [],
      platform: 'facebook',
      platformListingId: productResponse.data.id,
      status: quantity > 0 ? 'active' : 'inactive',
      lastUpdated: new Date().toISOString()
    };
    
    listings.set(listingId, newListing);
    
    res.status(201).json(newListing);
  } catch (error) {
    logError('Create Facebook listing', error, { req });
    res.status(500).json({ error: 'Failed to create Facebook listing' });
  }
});

// Delete a listing
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const listing = listings.get(id);
    
    if (!listing) {
      return res.status(404).send('Listing not found');
    }
    
    // Remove from our storage
    listings.delete(id);
    
    // Note: In a real implementation, you would also delete/archive from the actual platforms
    // For eBay, you'd end the listing
    // For Facebook, you'd delete the product from the catalog
    
    res.json({ success: true, message: 'Listing removed' });
  } catch (error) {
    logError('Delete listing', error, { req });
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.status === 401) {
    return res.status(401).json({ error: error.message || 'Sign in required' });
  }
  logError('Unhandled request error', error, { req });
  return res.status(500).json({ error: 'Unexpected server error' });
});

export default app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      open(`http://localhost:${PORT}/dashboard.html`).catch((error) => {
        logError('Open browser', error);
      });
    }
  });

  process.on('SIGINT', () => {
    console.log('Shutting down server...');
    try {
      persistStore();
      userStore.db.close();
    } catch (error) {
      logError('Persist session on shutdown', error);
    }
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}