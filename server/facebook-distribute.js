// server/facebook-distribute.js
//
// Facebook Marketplace distribution for the Crosslist auto-distribution flow.
//
// HONEST AUTOMATION NOTES (read before wiring this up):
// - Facebook Marketplace has NO public listing API. This server CANNOT post to
//   Facebook directly and never pretends to.
// - This module only creates a durable "distribution job" row in the local
//   sqlite database. The job is picked up by the "Crosslist Connector" Chrome
//   extension (extension/background.js, command CREATE_FACEBOOK_LISTING),
//   which drives the Facebook Marketplace composer inside the user's own
//   browser session.
// - That means this still requires, at distribution time:
//     (a) the Chrome extension installed,
//     (b) the user signed into Facebook in that Chrome profile,
//     (c) the dashboard (http://localhost:3000) open so it can relay the job
//         to the extension and POST the result back to the server.
// - If any of those is missing, the job fails with a clear, actionable error
//   and the failure is recorded via server/listing-failures.js.
//
// Flow:
//   1. distribute({identity, price, photoPaths, photoUrls}, ctx)
//        -> inserts a job row with status 'pending', returns {jobId}.
//   2. Dashboard (coordinator wires) polls GET /api/facebook/jobs/pending,
//      relays each job to the extension via CREATE_FACEBOOK_LISTING.
//   3. Extension fills the FB composer, clicks Publish, and returns a result.
//   4. Dashboard POSTs the result to /api/facebook/jobs/result, which calls
//      completeFacebookJob(userId, jobId, result). Success -> 'done';
//      failure -> 'failed' + sanitized listing failure recorded in the
//      activity log (deduplicated via server/listing-failures.js).

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db, appendActivity, hasListingFailure } from './db.js';
import { sanitizeListingFailure } from './listing-failures.js';

export const MARKETPLACE = 'facebook';

export const JOB_STATUSES = ['pending', 'claimed', 'done', 'failed'];

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // matches the extension's fetch cap

db.exec(`
  CREATE TABLE IF NOT EXISTS fb_distribution_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fb_jobs_user_status
    ON fb_distribution_jobs(user_id, status, created_at);
`);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function cleanPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100) / 100;
}

// Local photo paths are read server-side and embedded as data URLs so the
// extension needs zero per-item configuration: it just fills the form with
// the data URLs it is handed. Remote URLs are passed through as-is and the
// extension fetches them at pickup time (dashboardOrigin resolves '/…' paths).
function resolvePhotos(photoPaths = [], photoUrls = []) {
  const urls = [];
  for (const raw of (Array.isArray(photoUrls) ? photoUrls : [])) {
    const value = cleanText(raw, 4000);
    if (value) urls.push(value);
  }
  for (const raw of (Array.isArray(photoPaths) ? photoPaths : [])) {
    const filePath = cleanText(raw, 1024);
    if (!filePath || urls.length >= MAX_PHOTOS) continue;
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const size = fs.statSync(filePath).size;
      if (!size || size > MAX_PHOTO_BYTES) continue;
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/jpeg';
      urls.push(`data:${mime};base64,${buffer.toString('base64')}`);
    } catch {
      // A single unreadable photo must not kill the whole distribution job.
    }
  }
  return urls.slice(0, MAX_PHOTOS);
}

function buildJobPayload({ identity = {}, price, photoPaths, photoUrls }) {
  // Identity comes from the photo-intel step and carries structured fields
  // (brand/model/name/size/color/condition) — not a ready-made listing. The
  // job payload translates those into what the FB composer needs. Nothing
  // here asks the user anything: confirmation already happened upstream.
  const bits = [identity.brand, identity.name || identity.model, identity.size, identity.color]
    .map((part) => cleanText(part, 60))
    .filter(Boolean);
  const title = bits.join(' ').slice(0, 100);
  const descriptionBits = [];
  if (identity.model && identity.name && cleanText(identity.model) !== cleanText(identity.name)) {
    descriptionBits.push(`Model: ${cleanText(identity.model, 120)}`);
  }
  if (identity.size) descriptionBits.push(`Size: ${cleanText(identity.size, 60)}`);
  if (identity.color) descriptionBits.push(`Color: ${cleanText(identity.color, 60)}`);
  if (identity.condition) descriptionBits.push(`Condition: ${cleanText(identity.condition, 60)}`);
  const description = descriptionBits.join('\n');
  const amount = cleanPrice(price);
  return {
    title,
    description: cleanText(description || identity.description, 4000),
    price: amount,
    // No category in the identity schema; the extension attempts a best-effort
    // match and reports honestly when it cannot categorize.
    category: cleanText(identity.category || identity.fbCategory, 120),
    condition: cleanText(identity.condition || 'used', 60),
    brand: cleanText(identity.brand, 120),
    details: identity.details && typeof identity.details === 'object' ? identity.details : {},
    images: resolvePhotos(photoPaths, photoUrls),
  };
}

// Uniform distribute() interface shared by all marketplace distributors:
// distribute({identity, price, photoPaths, photoUrls}, ctx)
//   -> Promise<{ok, marketplace:'facebook', status:'pending'|'failed', jobId?, error?}>
//
// ctx: { userId } or { user: { id } } (the orchestrator passes ctx.user),
// plus optional { dashboardOrigin, source }.
export async function distribute(
  { identity = {}, price, photoPaths = [], photoUrls = [] } = {},
  ctx = {}
) {
  const userId = cleanText(ctx?.userId || ctx?.user?.id, 120);
  if (!userId) {
    return { ok: false, marketplace: MARKETPLACE, status: 'failed', error: 'Missing userId in ctx' };
  }

  const payload = buildJobPayload({ identity, price, photoPaths, photoUrls });
  if (!payload.title) {
    return { ok: false, marketplace: MARKETPLACE, status: 'failed', error: 'Missing listing title' };
  }
  if (payload.price == null) {
    return { ok: false, marketplace: MARKETPLACE, status: 'failed', error: 'Missing or invalid price' };
  }

  const jobId = uuidv4();
  const created = nowIso();
  db.prepare(`
    INSERT INTO fb_distribution_jobs
      (id, user_id, status, attempts, payload_json, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    jobId,
    userId,
    JSON.stringify({ ...payload, jobId, dashboardOrigin: cleanText(ctx.dashboardOrigin, 300) || '' }),
    created,
    created
  );

  try {
    appendActivity(userId, {
      type: 'info',
      source: 'server',
      message: `Queued Facebook distribution job for "${payload.title}"`,
      detail: { jobId, platform: MARKETPLACE, price: payload.price, photos: payload.images.length },
    });
  } catch {
    // Activity logging is best effort; the job row is the source of truth.
  }

  // 'pending' = queued for the Crosslist Connector Chrome extension. The
  // server does NOT touch Facebook itself.
  return { ok: true, marketplace: MARKETPLACE, status: 'pending', jobId };
}

export function getJob(jobId) {
  const row = db
    .prepare('SELECT * FROM fb_distribution_jobs WHERE id = ?')
    .get(String(jobId || ''));
  if (!row) return null;
  return rowToJob(row);
}

function rowToJob(row) {
  let payload = {};
  let result = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  try {
    result = row.result_json ? JSON.parse(row.result_json) : null;
  } catch {
    result = null;
  }
  return {
    jobId: row.id,
    userId: row.user_id,
    status: row.status,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    payload,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Jobs waiting for the extension to pick up. The dashboard (which holds the
// user's session) polls these and relays each one to the extension.
export function listPendingJobs(userId, limit = 10) {
  const rows = db
    .prepare(
      `SELECT * FROM fb_distribution_jobs
       WHERE user_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(String(userId || ''), Math.min(Math.max(Number(limit) || 10, 1), 50));
  return rows.map(rowToJob);
}

// Marks a pending job as claimed by the extension run (increments attempts
// so stuck jobs are visible). Returns the job or null if it wasn't pending.
export function claimJob(jobId) {
  const job = getJob(jobId);
  if (!job || job.status !== 'pending') return null;
  db.prepare(
    `UPDATE fb_distribution_jobs
     SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(nowIso(), nowIso(), job.jobId);
  return getJob(job.jobId);
}

// Status callback target: the dashboard POSTs the extension's result here
// (via the coordinator's /api/facebook/jobs/result route). Success records
// the listing id/url; failure is sanitized with server/listing-failures.js
// and recorded once in the activity log.
//
// result: { success, published, listingId, url, needsReview, error, step,
//           filled, photos, verification }
export function completeFacebookJob(userId, jobId, result = {}) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'Unknown job id' };
  if (String(job.userId) !== String(userId)) {
    return { ok: false, error: 'Job belongs to a different user' };
  }
  if (job.status === 'done' || job.status === 'failed') {
    return { ok: true, jobId, status: job.status, already: true };
  }

  const published = Boolean(result?.success) && (Boolean(result?.published) || Boolean(result?.listingId));
  const status = published ? 'done' : 'failed';
  const updated = nowIso();
  db.prepare(
    `UPDATE fb_distribution_jobs
     SET status = ?, result_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(status, JSON.stringify(result || {}), updated, jobId);

  const title = job.payload?.title || 'Facebook listing';

  if (published) {
    appendActivity(userId, {
      type: 'success',
      source: 'extension',
      message: `Facebook listing published for "${title}"`,
      detail: {
        jobId,
        platform: MARKETPLACE,
        listingId: result.listingId || null,
        url: result.url || null,
        verification: result.verification || 'redirect',
      },
    });
    return { ok: true, jobId, status: 'done' };
  }

  // Failure path: sanitize + dedupe exactly like the existing listing
  // failure pipeline in server.js (recordListingFailure).
  const raw = {
    id: uuidv4(),
    at: new Date().toISOString(),
    listingId: job.payload?.listingId || null,
    title,
    platform: MARKETPLACE,
    outcome: 'error',
    error: result?.error || 'Facebook distribution failed',
    step: result?.step || null,
    status: result?.status ?? null,
    source: 'extension',
    marketplaceCode: result?.marketplaceCode || null,
    trace: Array.isArray(result?.trace) ? result.trace : [],
  };
  const failure = sanitizeListingFailure(raw);
  if (failure?.id && !hasListingFailure(userId, failure.id)) {
    appendActivity(userId, {
      type: 'error',
      source: 'extension',
      message: `Facebook listing failed for "${title}"${failure.step ? ` while ${failure.step}` : ''}: ${failure.error}`,
      detail: {
        failureId: failure.id,
        jobId,
        listingId: failure.listingId,
        title: failure.title,
        platform: failure.platform,
        outcome: 'error',
        error: failure.error,
        step: failure.step,
        status: failure.status,
        marketplaceCode: failure.marketplaceCode,
        source: failure.source || 'extension',
        trace: failure.trace,
      },
    });
  }
  return { ok: false, jobId, status: 'failed', error: failure?.error || result?.error };
}
