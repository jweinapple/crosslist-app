// server/auto-distribute.js
//
// Photos-only auto-listing pipeline:
//
//   startAutoList(photoPaths, ctx)   -> persists a job, identifies the exact
//                                       product + a market price from sold
//                                       comps via server/photo-intel.js
//   confirmAutoList(jobId, {identity, price}, ctx)
//                                    -> queues one extension distribution job
//                                       per store (eBay, Grailed, Depop,
//                                       Poshmark, Etsy, Reverb) via the
//                                       uniform distributor interface; the
//                                       browser page relays each queued job to
//                                       the Chrome extension, which posts from
//                                       the user's logged-in session, then
//                                       reports the outcome back via
//                                       recordExtensionResults()
//                                    (Facebook Marketplace posting is NOT
//                                     handled by the app — the user posts
//                                     through Muse chat instead.)
//   getAutoListStatus(jobId, ctx)    -> per-marketplace status
//   recordExtensionResults(jobId, results, ctx)
//                                    -> applies the extension's per-store
//                                       outcomes to the job's statuses
//
// Distributor contract (implemented by sibling workers):
//   distribute({identity, price, photoPaths, photoUrls}, ctx)
//     -> Promise<{ok, marketplace, status, externalId?, url?, jobId?, error?}>
//
// Status vocabulary: 'listed' (live), 'pending' (queued, e.g. for the
// extension), 'guided' (distributor handed back a guided/manual step),
// 'needsReview' (distributor finished but flags the result for human review),
// 'failed' (true error). Diagnosis note: server/listing-failures.js
// hardcodes outcome:'error', so needsReview/pending/guided are first-class
// STATUSES here — only 'failed' goes through the failure-recording path.
//
// Distributor modules are loaded lazily with import(). If a module is missing
// (not finished yet) the marketplace is marked 'failed' with a clear error
// instead of crashing the whole run.

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { db, DATA_DIR, appendActivity, hasListingFailure } from './db.js';
import { sanitizeListingFailure, platformFailureLabel } from './listing-failures.js';

export const AUTO_LIST_MARKETPLACES = ['ebay', 'grailed', 'depop', 'poshmark', 'etsy', 'reverb'];
// First-class statuses. 'pending' | 'guided' | 'needsReview' are NOT failures:
// they render as their own states in the progress UI. Only 'failed' is
// recorded through server/listing-failures.js.
export const AUTO_LIST_STATUSES = ['listed', 'pending', 'guided', 'needsReview', 'failed'];
const UPLOADS_PREFIX = '/uploads/';

const DISTRIBUTOR_MODULES = {
  ebay: './ebay-distribute.js',
  grailed: './grailed-distribute.js',
  depop: './depop-distribute.js',
  poshmark: './poshmark-distribute.js',
  etsy: './etsy-distribute.js',
  reverb: './reverb-distribute.js',
};

const MARKETPLACE_LABELS = {
  ebay: 'eBay',
  grailed: 'Grailed',
  depop: 'Depop',
  poshmark: 'Poshmark',
  etsy: 'Etsy',
  reverb: 'Reverb',
};

// ---------------------------------------------------------------------------
// Persistence (follows server/db.js patterns: async db adapter + CREATE TABLE IF
// NOT EXISTS at module load, JSON columns for structured data)
// ---------------------------------------------------------------------------

await db.exec(`
  CREATE TABLE IF NOT EXISTS auto_list_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'identifying',
    photos_json TEXT NOT NULL DEFAULT '[]',
    identity_json TEXT,
    price_json TEXT,
    status_json TEXT NOT NULL DEFAULT '{}',
    error TEXT
  )
`);
await db.exec('CREATE INDEX IF NOT EXISTS idx_auto_list_jobs_user ON auto_list_jobs(user_id)');

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stage: row.stage,
    photos: parseJson(row.photos_json, []),
    identity: parseJson(row.identity_json, null),
    price: parseJson(row.price_json, null),
    statuses: parseJson(row.status_json, {}),
    error: row.error || null,
  };
}

async function createJobRow({ id, userId, photos }) {
  const created = nowIso();
  await db.run(
    `INSERT INTO auto_list_jobs (id, user_id, created_at, updated_at, stage, photos_json, status_json)
     VALUES (?, ?, ?, ?, 'identifying', ?, '{}')`,
    id,
    userId,
    created,
    created,
    JSON.stringify(photos || [])
  );
  return getJobRow(id);
}

async function getJobRow(jobId) {
  if (!jobId) return null;
  const row = await db.get('SELECT * FROM auto_list_jobs WHERE id = ?', String(jobId));
  return rowToJob(row);
}

async function updateJobRow(jobId, patch) {
  const sets = [];
  const args = [];
  if (patch.stage !== undefined) {
    sets.push('stage = ?');
    args.push(patch.stage);
  }
  if (patch.identity !== undefined) {
    sets.push('identity_json = ?');
    args.push(patch.identity == null ? null : JSON.stringify(patch.identity));
  }
  if (patch.price !== undefined) {
    sets.push('price_json = ?');
    args.push(patch.price == null ? null : JSON.stringify(patch.price));
  }
  if (patch.statuses !== undefined) {
    sets.push('status_json = ?');
    args.push(JSON.stringify(patch.statuses || {}));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    args.push(patch.error == null ? null : String(patch.error).slice(0, 1000));
  }
  sets.push('updated_at = ?');
  args.push(nowIso());
  args.push(String(jobId));
  await db.run(`UPDATE auto_list_jobs SET ${sets.join(', ')} WHERE id = ?`, ...args);
  return getJobRow(jobId);
}

// ---------------------------------------------------------------------------
// Test seams: sibling modules are injected here by the test suite; production
// always loads the real files lazily via import().
// ---------------------------------------------------------------------------

const testOverrides = {
  photoIntel: null,
  distributors: { ebay: null, grailed: null, depop: null, poshmark: null, etsy: null, reverb: null },
};

/** @internal — test only */
export function __setAutoListTestModules({ photoIntel, distributors } = {}) {
  if (photoIntel !== undefined) testOverrides.photoIntel = photoIntel;
  if (distributors) {
    for (const key of AUTO_LIST_MARKETPLACES) {
      if (distributors[key] !== undefined) testOverrides.distributors[key] = distributors[key];
    }
  }
}

/** @internal — test only */
export function __clearAutoListTestModules() {
  testOverrides.photoIntel = null;
  for (const key of AUTO_LIST_MARKETPLACES) testOverrides.distributors[key] = null;
}

// ---------------------------------------------------------------------------
// Module loading with graceful handling for missing/unfinished modules
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function extractDistribute(mod, marketplace) {
  const fn = mod?.distribute || mod?.default?.distribute || mod?.default;
  if (typeof fn !== 'function') {
    return { error: `Distributor for ${marketplaceLabel(marketplace)} is present but does not export a distribute() function` };
  }
  return { distribute: fn };
}

async function loadDistributor(marketplace) {
  const injected = testOverrides.distributors[marketplace];
  if (injected) {
    if (injected instanceof Error) return { error: injected.message };
    return extractDistribute({ distribute: injected.distribute || injected }, marketplace);
  }
  const modulePath = DISTRIBUTOR_MODULES[marketplace];
  try {
    const mod = await import(modulePath);
    return extractDistribute(mod, marketplace);
  } catch (error) {
    return {
      error:
        `The ${marketplaceLabel(marketplace)} distributor (${modulePath}) ` +
        `is not available yet: ${error?.message || error}`,
    };
  }
}

function extractPhotoIntel(mod) {
  const identifyProduct =
    mod?.identifyProduct || mod?.default?.identifyProduct;
  const suggestPrice = mod?.suggestPrice || mod?.default?.suggestPrice;
  if (typeof identifyProduct !== 'function' || typeof suggestPrice !== 'function') {
    return {
      error:
        'The photo-intel module (server/photo-intel.js) is present but does not export ' +
        'identifyProduct() and suggestPrice()',
    };
  }
  return { identifyProduct, suggestPrice };
}

async function loadPhotoIntel() {
  if (testOverrides.photoIntel) {
    if (testOverrides.photoIntel instanceof Error) {
      return { error: testOverrides.photoIntel.message };
    }
    return extractPhotoIntel(testOverrides.photoIntel);
  }
  const modulePath = './photo-intel.js';
  try {
    const mod = await import(modulePath);
    return extractPhotoIntel(mod);
  } catch (error) {
    return {
      error:
        `Photo identification is not available yet (${modulePath} could not be loaded): ` +
        `${error?.message || error}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Photo paths: reuse the existing UPLOADS_DIR storage (local mode) or
// accept absolute https photo URLs (Vercel Blob mode).
// Accepts '/uploads/<owner>/<file>' URLs (as returned by POST /api/uploads),
// https:// URLs (as returned by POST /api/uploads when BLOB_READ_WRITE_TOKEN
// is set — they are already absolute, which is what the extension listing
// payloads need), or absolute filesystem paths inside the data dir.
// ---------------------------------------------------------------------------

function uploadsDir() {
  return path.join(DATA_DIR, 'uploads');
}

export function resolveAutoListPhotos(photos, baseUrl = '') {
  const list = Array.isArray(photos) ? photos : [photos];
  const origin = String(baseUrl || '').replace(/\/$/, '');
  const out = [];
  for (const raw of list) {
    const value = String(raw || '').trim();
    if (!value) continue;
    let fsPath;
    let url;
    if (value.startsWith(UPLOADS_PREFIX)) {
      fsPath = path.normalize(path.join(DATA_DIR, value));
      if (!fsPath.startsWith(uploadsDir() + path.sep) && fsPath !== uploadsDir()) {
        throw httpError(400, `Photo path is outside the uploads directory: ${value}`);
      }
      url = origin ? `${origin}${value}` : value;
    } else if (/^https:\/\//i.test(value)) {
      // Vercel Blob photo: already an absolute URL with nothing on local
      // disk to validate. The extension listing payloads consume the URL
      // directly; photo-intel fetches the bytes from the URL when needed.
      out.push({ path: value, url: value });
      continue;
    } else if (/^http:\/\//i.test(value)) {
      throw httpError(400, `Only https photo URLs are accepted by the auto-list flow: ${value.slice(0, 80)}`);
    } else {
      fsPath = path.normalize(path.resolve(value));
      if (!fsPath.startsWith(path.resolve(DATA_DIR) + path.sep)) {
        throw httpError(400, `Photo path is outside the app data directory: ${value}`);
      }
      const rel = path.relative(uploadsDir(), fsPath).split(path.sep).join('/');
      url = rel.startsWith('..')
        ? origin || fsPath
        : origin
          ? `${origin}${UPLOADS_PREFIX}${rel}`
          : `${UPLOADS_PREFIX}${rel}`;
    }
    if (!fs.existsSync(fsPath)) {
      throw httpError(400, `Photo not found: ${value}`);
    }
    const stat = fs.statSync(fsPath);
    if (!stat.isFile() || stat.size === 0) {
      throw httpError(400, `Photo is not a readable file: ${value}`);
    }
    out.push({ path: fsPath, url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sanitizers for user-confirmed values
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = ['brand', 'model', 'name', 'size', 'color', 'condition'];

function cleanText(value, max = 160) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeIdentity(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const identity = {};
  for (const field of IDENTITY_FIELDS) identity[field] = cleanText(source[field]);
  const confidence = Number(source.confidence);
  identity.confidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence))
    : null;
  return identity;
}

export function sanitizePrice(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const amount = Number(source.price ?? source.amount ?? raw);
  if (!Number.isFinite(amount) || amount < 0) {
    throw httpError(400, 'Price must be a number of 0 or more');
  }
  return {
    price: Math.round(amount * 100) / 100,
    currency: cleanText(source.currency || 'USD', 8).toUpperCase() || 'USD',
    comps: Array.isArray(source.comps)
      ? source.comps.slice(0, 20).map((comp) => sanitizeComp(comp))
      : [],
    rationale: cleanText(source.rationale, 2000),
  };
}

function sanitizeComp(raw) {
  const comp = raw && typeof raw === 'object' ? raw : {};
  const price = Number(comp.price ?? comp.soldPrice);
  return {
    title: cleanText(comp.title, 200),
    price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    soldDate: cleanText(comp.soldDate || comp.date, 40),
    url: cleanText(comp.url, 400),
    source: cleanText(comp.source, 60),
  };
}

export function marketplaceLabel(marketplace) {
  return MARKETPLACE_LABELS[marketplace] || marketplace;
}

export function identityDisplayName(identity) {
  const parts = [identity?.brand, identity?.name || identity?.model].filter(Boolean);
  return parts.join(' ').trim() || 'Untitled item';
}

// ---------------------------------------------------------------------------
// Failure recording via the existing server/listing-failures.js system
// ---------------------------------------------------------------------------

async function recordAutoListFailure(userId, { marketplace, title, error }) {
  if (!userId) return;
  const failure = sanitizeListingFailure({
    at: nowIso(),
    platform: marketplace,
    title: title || 'auto-list item',
    error: error || 'Distribution failed',
    step: 'auto-distribution',
    source: 'server',
  });
  if (!failure) return;
  if (failure.id && (await hasListingFailure(userId, failure.id))) return;
  try {
    await appendActivity(userId, {
      type: 'error',
      source: 'auto-list',
      message: `${marketplaceLabel(marketplace)} auto-list failed for "${failure.title}": ${failure.error}`,
      detail: {
        platform: failure.platform,
        title: failure.title,
        step: failure.step,
        error: failure.error,
      },
    });
  } catch (activityError) {
    console.warn('auto-list: could not record failure activity:', activityError.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Step 1 — start an auto-list job from uploaded photos.
 * Identifies the exact product and suggests a market price from sold comps.
 */
export async function startAutoList(photos, ctx = {}) {
  const user = ctx.user;
  if (!user?.id) throw httpError(401, 'Sign in required');
  const resolved = resolveAutoListPhotos(photos, ctx.baseUrl);
  if (!resolved.length) throw httpError(400, 'Upload at least one photo to start');

  const jobId = `auto_${uuidv4()}`;
  await createJobRow({ id: jobId, userId: user.id, photos: resolved });

  const intel = await loadPhotoIntel();
  if (intel.error) {
    await updateJobRow(jobId, { stage: 'failed', error: intel.error });
    const error = httpError(503, intel.error);
    error.jobId = jobId;
    throw error;
  }

  try {
    const rawIdentity = await intel.identifyProduct(resolved.map((p) => p.path));
    const identity = sanitizeIdentity(rawIdentity);
    const rawPricing = await intel.suggestPrice(identity);
    const pricing = sanitizePrice(rawPricing);
    await updateJobRow(jobId, {
      stage: 'awaiting_confirmation',
      identity,
      price: pricing,
    });
    return {
      jobId,
      identity,
      price: pricing.price,
      currency: pricing.currency,
      comps: pricing.comps,
      rationale: pricing.rationale,
      confidence: identity.confidence,
    };
  } catch (error) {
    const message = error?.message || 'Photo analysis failed';
    await updateJobRow(jobId, { stage: 'failed', error: message });
    if (error?.status) throw error;
    const wrapped = httpError(502, `Photo analysis failed: ${message}`);
    wrapped.jobId = jobId;
    throw wrapped;
  }
}

function normalizeDistributorResult(marketplace, result) {
  let status = result?.status;
  if (status === 'needs_review') status = 'needsReview';
  // A distributor can flag needsReview without setting status explicitly.
  if (result?.needsReview === true && !AUTO_LIST_STATUSES.includes(status)) {
    status = 'needsReview';
  }
  status = AUTO_LIST_STATUSES.includes(status) ? status : 'failed';
  const record = {
    marketplace,
    status,
    externalId: result?.externalId != null ? String(result.externalId).slice(0, 120) : null,
    url: result?.url != null ? String(result.url).slice(0, 500) : null,
    jobId: result?.jobId != null ? String(result.jobId).slice(0, 120) : null,
    error: result?.error != null ? String(result.error).slice(0, 500) : null,
    needsReview: status === 'needsReview' || undefined,
  };
  if (status === 'failed' && !record.error) {
    record.error =
      result && !AUTO_LIST_STATUSES.includes(result.status)
        ? `Distributor returned an unrecognized status: ${String(result.status).slice(0, 80)}`
        : 'Distribution failed';
  }
  if (status !== 'failed') record.error = null;
  // Carry the extension task through so the browser page can relay the queued
  // job to the extension (the task holds the listing payload + photo URLs).
  if (result?.extensionTask) record.extensionTask = result.extensionTask;
  return record;
}

// Distributors speak the uniform interface
//   distribute({identity, price, photoPaths, photoUrls}, ctx)
// but a couple of them also read convenience fields off identity (title,
// description, details). Those are derived from the confirmed fields —
// nothing the user didn't approve.
function buildDistributorPayload(finalIdentity, finalPrice, job) {
  const title = identityDisplayName(finalIdentity);
  const detailBits = [];
  if (finalIdentity.model && finalIdentity.model !== finalIdentity.name) {
    detailBits.push(`Model: ${finalIdentity.model}`);
  }
  if (finalIdentity.size) detailBits.push(`Size: ${finalIdentity.size}`);
  if (finalIdentity.color) detailBits.push(`Color: ${finalIdentity.color}`);
  if (finalIdentity.condition) detailBits.push(`Condition: ${finalIdentity.condition}`);
  return {
    identity: {
      ...finalIdentity,
      title,
      description: [title, detailBits.join(' · ')].filter(Boolean).join('\n'),
      details: {
        brand: finalIdentity.brand,
        designer: finalIdentity.brand,
        size: finalIdentity.size,
        color: finalIdentity.color,
      },
    },
    price: finalPrice.price,
    currency: finalPrice.currency,
    photoPaths: job.photos.map((p) => p.path),
    photoUrls: job.photos.map((p) => p.url),
  };
}

// Sibling distributors were written against ctx shapes like
// { userId, dashboardOrigin, extensionAvailable } — pass those through
// alongside our own ctx so the uniform call works for both distributors.
function buildDistributorCtx(ctx = {}) {
  return {
    ...ctx,
    userId: ctx?.user?.id || '',
    dashboardOrigin: String(ctx?.baseUrl || '').replace(/\/$/, ''),
  };
}
async function runDistributor(marketplace, payload, ctx, job) {
  const loaded = await loadDistributor(marketplace);
  if (loaded.error) {
    return { marketplace, status: 'failed', externalId: null, url: null, jobId: null, error: loaded.error };
  }
  try {
    const result = await loaded.distribute(payload, ctx);
    return normalizeDistributorResult(marketplace, result);
  } catch (error) {
    return {
      marketplace,
      status: 'failed',
      externalId: null,
      url: null,
      jobId: null,
      error: error?.message || String(error) || 'Distribution failed',
    };
  }
}

/**
 * Step 2 — confirm the identified product + price (ONE screen, no
 * per-marketplace configuration), then distribute everywhere.
 */
export async function confirmAutoList(jobId, { identity, price } = {}, ctx = {}) {
  const user = ctx.user;
  if (!user?.id) throw httpError(401, 'Sign in required');
  const job = await getJobRow(jobId);
  if (!job) throw httpError(404, 'Auto-list job not found');
  if (job.userId !== user.id) throw httpError(403, 'This auto-list job belongs to another account');
  if (job.stage !== 'awaiting_confirmation') {
    throw httpError(
      409,
      job.stage === 'done'
        ? 'This job was already confirmed and distributed'
        : `This job is ${job.stage}; confirm it from the confirmation step first`
    );
  }

  const finalIdentity = sanitizeIdentity(identity ?? job.identity);
  const finalPrice = sanitizePrice(price ?? job.price);

  await updateJobRow(jobId, { stage: 'distributing', identity: finalIdentity, price: finalPrice });

  const payload = buildDistributorPayload(finalIdentity, finalPrice, job);
  const distCtx = buildDistributorCtx(ctx);

  const statuses = {};
  for (const marketplace of AUTO_LIST_MARKETPLACES) {
    const record = await runDistributor(marketplace, payload, distCtx, job);
    statuses[marketplace] = record;
    if (record.status === 'failed') {
      await recordAutoListFailure(user.id, {
        marketplace,
        title: identityDisplayName(finalIdentity),
        error: record.error,
      });
    }
    await updateJobRow(jobId, { statuses });
  }

  await updateJobRow(jobId, { stage: 'done' });
  return {
    jobId,
    statuses: AUTO_LIST_MARKETPLACES.map((marketplace) => statuses[marketplace]),
  };
}

/**
 * Step 3 — read the current per-marketplace status of a job.
 */
export async function getAutoListStatus(jobId, ctx = {}) {
  const user = ctx.user;
  if (!user?.id) throw httpError(401, 'Sign in required');
  const job = await getJobRow(jobId);
  if (!job) throw httpError(404, 'Auto-list job not found');
  if (job.userId !== user.id) throw httpError(403, 'This auto-list job belongs to another account');
  return {
    jobId: job.id,
    stage: job.stage,
    identity: job.identity,
    price: job.price?.price ?? null,
    currency: job.price?.currency ?? 'USD',
    comps: job.price?.comps ?? [],
    rationale: job.price?.rationale ?? '',
    confidence: job.identity?.confidence ?? null,
    photos: job.photos.map((p) => p.url),
    statuses: AUTO_LIST_MARKETPLACES.map((marketplace) => ({
      marketplace,
      ...(job.statuses?.[marketplace] || { status: job.stage === 'done' ? 'failed' : null }),
    })),
    error: job.error,
  };
}

/**
 * Step 4 — apply the extension's per-store outcomes to a job.
 *
 * Called by the browser page after it relays queued ('pending') jobs to the
 * Chrome extension: each result is { marketplace, status, externalId?, url?,
 * error?, needsReview? }. Only extension-reported outcomes may overwrite a
 * record, and a 'listed' record is never downgraded by a later report.
 */
export async function recordExtensionResults(jobId, results = [], ctx = {}) {
  const user = ctx.user;
  if (!user?.id) throw httpError(401, 'Sign in required');
  const job = await getJobRow(jobId);
  if (!job) throw httpError(404, 'Auto-list job not found');
  if (job.userId !== user.id) throw httpError(403, 'This auto-list job belongs to another account');
  const statuses = { ...(job.statuses || {}) };
  for (const result of Array.isArray(results) ? results : []) {
    const marketplace = String(result?.marketplace || '');
    if (!AUTO_LIST_MARKETPLACES.includes(marketplace)) continue;
    const current = statuses[marketplace];
    const normalized = normalizeDistributorResult(marketplace, result);
    if (current?.status === 'listed' && normalized.status !== 'listed') continue;
    statuses[marketplace] = { ...current, ...normalized };
    if (normalized.status === 'failed') {
      await recordAutoListFailure(user.id, {
        marketplace,
        title: identityDisplayName(job.identity),
        error: normalized.error,
      });
    }
  }
  await updateJobRow(jobId, { statuses });
  return {
    jobId,
    statuses: AUTO_LIST_MARKETPLACES.map((marketplace) => statuses[marketplace]),
  };
}

/** @internal — test/helper only: wipe auto-list jobs for a user */
export async function __deleteAutoListJobsForUser(userId) {
  await db.run('DELETE FROM auto_list_jobs WHERE user_id = ?', String(userId));
}
