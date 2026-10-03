/**
 * server/extension-distribute.js — shared core for extension-driven distribution.
 *
 * ARCHITECTURE (extension-only distribution): every store posts through the
 * user's own logged-in browser session via the Crosslist Connector Chrome
 * extension. No store API credentials are needed for posting. The server's
 * job here is deliberately thin:
 *
 *   1. validate the listing payload (title, price),
 *   2. persist a distribution job row (audit trail + status),
 *   3. hand the browser an `extensionTask` the page relays to the extension
 *      with the CREATE_MARKETPLACE_LISTINGS command (the same command the
 *      dashboard bulk flow already uses),
 *   4. return { status: 'pending' } — the browser reports the real outcome
 *      back via recordExtensionResults() once the extension finishes.
 *
 * At distribution time the user needs: the extension installed and enabled,
 * logged into each target store in that Chrome profile, and this dashboard
 * page reachable (the extension fetches listing photos from the dashboard
 * origin, so the page must stay open on a host the extension can reach).
 *
 * API *import* paths are untouched by this module — this is posting only.
 */

import { db } from './db.js';
import { randomUUID } from 'node:crypto';

// Per-store config for the extension fill path. createUrl mirrors the
// extension's own CREATE_URLS (extension/background.js); reverb is null
// because the extension posts it through its session lister instead of a
// form page.
export const EXTENSION_DISTRIBUTION_STORES = {
  ebay: {
    label: 'eBay',
    createUrl: 'https://www.ebay.com/sl/prelist/suggest',
    photoLimit: 24,
    mapCondition: mapEbayCondition,
  },
  depop: {
    label: 'Depop',
    createUrl: 'https://www.depop.com/products/create/',
    photoLimit: 10,
    mapCondition: mapDepopCondition,
  },
  poshmark: {
    label: 'Poshmark',
    createUrl: 'https://poshmark.com/create-listing',
    photoLimit: 16,
    mapCondition: (value) => String(value || 'used_good'),
  },
  etsy: {
    label: 'Etsy',
    createUrl: 'https://www.etsy.com/your/shops/me/tools/listings/create',
    photoLimit: 10,
    mapCondition: (value) => String(value || 'used_good'),
  },
  reverb: {
    label: 'Reverb',
    createUrl: null,
    photoLimit: 10,
    mapCondition: (value) => String(value || 'used_good'),
  },
};

// eBay condition token expected by the extension's eBay form fill.
// (Ported from the retired server/ebay-auto.js Sell API path; the mapping
// itself is store vocabulary, not API logic.)
export function mapEbayCondition(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  if (key === 'new') return 'NEW';
  if (key === 'like_new' || key === 'used_excellent') return 'USED_EXCELLENT';
  if (key === 'used_fair' || key === 'fair') return 'USED_ACCEPTABLE';
  return 'USED_GOOD';
}

// Depop condition token expected by the extension's Depop form fill.
// (Ported from the retired server.js createDepopListingViaApi helper.)
export function mapDepopCondition(condition) {
  const key = String(condition || 'used_good').toLowerCase().replace(/\s+/g, '_');
  const conditionMap = {
    new: 'new_with_tags',
    brand_new: 'new_with_tags',
    like_new: 'new_without_tags',
    mint: 'new_without_tags',
    used_excellent: 'used_excellent',
    excellent: 'used_excellent',
    used_good: 'used_good',
    used_fair: 'used_fair',
    fair: 'used_fair',
    poor: 'used_fair',
  };
  return conditionMap[key] || 'used_good';
}

// ---------------------------------------------------------------------------
// Job persistence (audit trail; mirrors the grailed_jobs pattern).
// ---------------------------------------------------------------------------

await db.exec(`
  CREATE TABLE IF NOT EXISTS extension_distribution_jobs (
    id TEXT PRIMARY KEY,
    marketplace TEXT NOT NULL,
    user_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT,
    price REAL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )
`);

const jobStore = {
  async insert(job) {
    await db.run(
      `INSERT INTO extension_distribution_jobs
         (id, marketplace, user_id, status, title, price, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.marketplace,
      job.userId || null,
      job.status || 'pending',
      job.title || null,
      job.price ?? null,
      job.payloadJson || null,
      job.createdAt || new Date().toISOString(),
      job.updatedAt || new Date().toISOString()
    );
    return job.id;
  },
  async get(id) {
    const row = await db.get('SELECT * FROM extension_distribution_jobs WHERE id = ?', String(id || ''));
    return row || null;
  },
  async updateStatus(id, status, extra = {}) {
    await db.run(
      `UPDATE extension_distribution_jobs
         SET status = ?, updated_at = ?
       WHERE id = ?`,
      status,
      new Date().toISOString(),
      String(id || '')
    );
    return jobStore.get(id);
  },
};

// Test seam: swap the sqlite-backed store for an in-memory one.
export function __setJobStore(store) {
  jobStore.insert = store.insert.bind(store);
  jobStore.get = store.get.bind(store);
  jobStore.updateStatus =
    store.updateStatus?.bind(store) ||
    ((id, status) => {
      const row = store.get(String(id || ''));
      if (row) row.status = status;
      return row || null;
    });
}

/** Read back a queued distribution job. */
export async function getExtensionJob(jobId) {
  return jobStore.get(String(jobId || ''));
}

/** Update a distribution job's status (called when the extension reports back). */
export async function markExtensionJob(jobId, status) {
  return jobStore.updateStatus(String(jobId || ''), status);
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return max ? text.slice(0, max) : text;
}

/**
 * Resolve photo URLs the extension can fetch. The extension downloads each
 * image from the dashboard origin, so relative /uploads URLs are absolutized
 * against ctx.dashboardOrigin (set by the orchestrator from the request).
 */
export function normalizeExtensionPhotos(photoUrls, ctx = {}, photoLimit = 10) {
  const origin = String(ctx.dashboardOrigin || '').replace(/\/+$/, '');
  const urls = [];
  for (const raw of Array.isArray(photoUrls) ? photoUrls : []) {
    const url = String(raw || '').trim();
    if (!url) continue;
    if (/^https?:\/\//i.test(url)) urls.push(url);
    else if (url.startsWith('/') && origin) urls.push(origin + url);
    if (urls.length >= photoLimit) break;
  }
  return urls;
}

function failed(marketplace, message) {
  return { ok: false, marketplace, status: 'failed', error: message };
}

/**
 * Queue an extension distribution job and return the task the browser page
 * relays to the extension. Always returns 'pending' on valid input — only
 * the browser knows whether the extension is actually installed, so the
 * installed-extension fallback ("guided") is decided page-side.
 */
export async function distributeViaExtension(marketplace, payload = {}, ctx = {}) {
  const config = EXTENSION_DISTRIBUTION_STORES[marketplace];
  if (!config) return failed(marketplace, `Unsupported marketplace: ${marketplace}`);

  const identity = payload.identity || {};
  const title = cleanText(identity.title, 140);
  if (!title) return failed(marketplace, 'Add a title before distributing.');
  const price = Number(payload.price);
  if (!Number.isFinite(price) || price < 0) {
    return failed(marketplace, 'Set a valid price of 0 or more before distributing.');
  }

  const images = normalizeExtensionPhotos(payload.photoUrls, ctx, config.photoLimit);
  const listing = {
    title,
    description: cleanText(identity.description, 8000),
    price,
    currency: 'USD',
    images,
    condition: config.mapCondition(identity.condition),
    quantity: 1,
    category: identity.category || 'other',
    details: identity.details || {},
  };

  const jobId = randomUUID();
  const extensionTask = {
    platform: marketplace,
    createUrl: config.createUrl,
    dashboardOrigin: String(ctx.dashboardOrigin || ''),
    listing,
  };
  await jobStore.insert({
    id: jobId,
    marketplace,
    userId: ctx.userId || null,
    status: 'pending',
    title,
    price,
    payloadJson: JSON.stringify(extensionTask),
  });

  return { ok: true, marketplace, status: 'pending', jobId, extensionTask };
}

/**
 * Create a distributor with the uniform contract:
 *   distribute({ identity, price, photoPaths, photoUrls }, ctx)
 *     -> { ok, marketplace, status: 'pending'|'failed', jobId?, extensionTask?, error? }
 */
export function createExtensionDistributor(marketplace) {
  const config = EXTENSION_DISTRIBUTION_STORES[marketplace];
  if (!config) throw new Error(`No extension distribution config for marketplace: ${marketplace}`);
  const distribute = (payload, ctx) => distributeViaExtension(marketplace, payload, ctx);
  return { marketplace, label: config.label, distribute };
}
