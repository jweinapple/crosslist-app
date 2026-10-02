/* server/grailed-distribute.js — Grailed distribution path for Crosslist.
 *
 * HONESTY NOTES (read before touching this file):
 * - Grailed has NO public listing API. Verified 2026-10-02: Grailed publishes
 *   no developer docs or listing endpoints; the only third-party integrations
 *   in the wild are read-only scrapers (search/sold comps) or browser
 *   form-fillers (e.g. github.com/aidanz06/grailed-automation — "form-fill
 *   assistance, not a bot … never clicks Publish"). Nothing here invents an
 *   endpoint; nothing here pretends the server posted a listing.
 * - The only real distribution channel is the Chrome extension's content
 *   script (extension/content-grailed.js), which fills the sell form at
 *   https://www.grailed.com/sell/new inside the user's own logged-in browser.
 *   The user always reviews and publishes manually.
 * - distribute() therefore has exactly three honest outcomes:
 *     'pending' — queued for the extension; nothing is live on Grailed yet.
 *     'guided'  — no extension available; the server returns a prefilled
 *                 checklist the user completes on grailed.com themselves.
 *     'failed'  — validation failed (missing title/price); nothing queued.
 * - Default when the extension's availability is unknown: 'guided'. Claiming
 *   'pending' without proof of a connected extension would be faking a queue.
 */

import { db } from './db.js';
import { randomUUID } from 'node:crypto';

const GRAILED_SELL_URL = 'https://www.grailed.com/sell/new';

// Table mirrors the CREATE TABLE IF NOT EXISTS pattern in server/db.js.
// (Coordinator: this table could move into db.js's schema block later; the
// idempotent CREATE here means db.js is not required to change for this to work.)
db.exec(`
  CREATE TABLE IF NOT EXISTS grailed_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    price REAL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_grailed_jobs_user ON grailed_jobs(user_id, created_at);
`);

// Default persistence layer; tests override with __setJobStore() so they
// never touch the real sqlite file.
const jobStore = {
  insert(job) {
    db.prepare(
      `INSERT INTO grailed_jobs (id, user_id, created_at, status, title, price, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id,
      job.user_id,
      job.created_at,
      job.status,
      job.title,
      job.price,
      JSON.stringify(job.payload)
    );
    return job.id;
  },
  get(id) {
    const row = db.prepare('SELECT * FROM grailed_jobs WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, payload: JSON.parse(row.payload_json) };
  },
};

/** Test hook: swap the persistence layer (e.g. an in-memory mock). */
export function __setJobStore(store) {
  jobStore.insert = store.insert.bind(store);
  jobStore.get = store.get.bind(store);
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : 0;
}

/** Keep only URLs the extension can actually use: data: uploads or https:. */
export function normalizeGrailedPhotos(photoPaths = [], photoUrls = []) {
  const out = [];
  for (const url of [...(photoUrls || []), ...(photoPaths || [])]) {
    const value = String(url || '').trim();
    if (/^data:image\//i.test(value) || /^https:\/\//i.test(value)) out.push(value);
  }
  return out.slice(0, 10);
}

/** Crosslist condition key → closest Grailed sell-form condition label. */
export function mapGrailedCondition(condition) {
  const key = String(condition || 'used_good').toLowerCase().replace(/[\s_]+/g, ' ').trim();
  const map = {
    new: 'new',
    'brand new': 'new',
    'like new': 'like new',
    mint: 'like new',
    excellent: 'gently used',
    'used excellent': 'gently used',
    'used good': 'used',
    good: 'used',
    'used fair': 'used',
    fair: 'used',
    poor: 'very worn',
  };
  return map[key] || 'used';
}

/** Build the honest, human-completable checklist for the 'guided' path. */
function buildGuide({ title, description, price, photos, identity }) {
  const details = identity?.details && typeof identity.details === 'object' ? identity.details : {};
  const rows = [
    ['Title', title],
    ['Designer / brand', details.designer || details.brand || '(pick on grailed.com)'],
    ['Price (USD)', price ? `$${price}` : '(set on grailed.com)'],
    ['Condition', mapGrailedCondition(identity?.condition)],
    ['Size', details.size || '(pick on grailed.com)'],
    ['Color', details.color || '(pick on grailed.com)'],
    [
      'Description',
      description ? description.slice(0, 120) + (description.length > 120 ? '…' : '') : '(add on grailed.com)',
    ],
    ['Photos', `${photos.length} ready — download them from the dashboard, then upload on grailed.com`],
  ];
  const steps = [
    `Open ${GRAILED_SELL_URL} and sign in to Grailed.`,
    'Upload the item photos.',
    'Confirm the category, then the size / sub-category / designer cascade — Grailed requires a human-confirmed category.',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    'Review everything, then click Publish yourself. Crosslist never publishes to Grailed for you.',
  ];
  return {
    url: GRAILED_SELL_URL,
    steps,
    prefill: { title, description, price, condition: mapGrailedCondition(identity?.condition), details },
    note: 'Grailed offers no listing API, so this step runs in your browser. The extension can prefill the form when it is connected.',
  };
}

/**
 * Distribute one item to Grailed.
 *
 * @param {object} input
 * @param {object} input.identity  product identity: {title, description, condition, details{designer,brand,size,color}, ...}
 * @param {number|string} input.price
 * @param {string[]} input.photoPaths  local/data photo URLs
 * @param {string[]} input.photoUrls   remote https photo URLs
 * @param {object} [ctx]
 * @param {string} [ctx.userId]
 * @param {boolean} [ctx.extensionAvailable]  MUST be explicitly true to queue;
 *        unknown/absent → 'guided' (we never fake a queue).
 * @returns {Promise<{ok, marketplace:'grailed', status:'pending'|'guided'|'failed', jobId?, guide?, error?}>}
 */
export async function distribute(
  { identity = {}, price, photoPaths = [], photoUrls = [] } = {},
  ctx = {}
) {
  const title = cleanText(identity.title, 140);
  const amount = cleanPrice(price ?? identity.price);
  const description = cleanText(identity.description, 2000);
  const photos = normalizeGrailedPhotos(photoPaths, photoUrls);

  if (!title) {
    return { ok: false, marketplace: 'grailed', status: 'failed', error: 'Title is required' };
  }
  if (!amount) {
    return { ok: false, marketplace: 'grailed', status: 'failed', error: 'Price is required' };
  }

  // No provable extension connection → honest guided step, never a fake queue.
  if (ctx.extensionAvailable !== true) {
    return {
      ok: true,
      marketplace: 'grailed',
      status: 'guided',
      guide: buildGuide({ title, description, price: amount, photos, identity }),
    };
  }

  const payload = {
    title,
    description,
    price: amount,
    condition: mapGrailedCondition(identity.condition),
    quantity: 1,
    images: photos,
    sku: cleanText(identity.sku, 80),
    details: identity.details && typeof identity.details === 'object' ? identity.details : {},
    // Extension hint for the category → size → designer cascade. This is only
    // ever advisory: the content script fills it best-effort and the seller
    // confirms it on grailed.com.
    grailed: identity.grailed && typeof identity.grailed === 'object' ? identity.grailed : {},
  };

  const job = {
    id: `grailed_${randomUUID()}`,
    user_id: String(ctx.userId || 'anonymous'),
    created_at: new Date().toISOString(),
    status: 'pending',
    title,
    price: amount,
    payload,
  };
  jobStore.insert(job);

  return {
    ok: true,
    marketplace: 'grailed',
    status: 'pending',
    jobId: job.id,
    // Coordinator: hand this to the extension as the job payload for
    // CREATE_GRAILED_LISTING at https://www.grailed.com/sell/new.
    job,
  };
}

/** Read back a queued job (used by the extension handoff / dashboard status). */
export function getJob(jobId) {
  return jobStore.get(String(jobId || ''));
}
