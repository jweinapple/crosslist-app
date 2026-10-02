/**
 * server/ebay-auto.js — fully automatic eBay distribution for the crosslist pipeline.
 *
 * TARGET FLOW: photos-only upload → identify + market price → one confirmation screen
 * → distribute() posts the listing to eBay with zero per-item configuration.
 *
 * The user never configures anything per item. eBay credentials (client id/secret,
 * OAuth tokens) are owned entirely by server.js's existing OAuth flow; this module
 * takes a ready access token via dependency injection (ctx.ebayAuth) and never
 * touches OAuth, refresh, or .env itself.
 *
 * Exported contract:
 *   distribute({ identity, price, photoPaths, photoUrls }, ctx)
 *     -> Promise<{ ok, marketplace: 'ebay', status: 'listed' | 'failed',
 *                 externalId?, url?, error?, trace? }>
 *
 * identity: { brand, model, name, size, color, condition, year?, season?, gender? }
 * price:    confirmed USD price (number).
 * photoUrls:  absolute https URLs eBay can fetch (preferred).
 * photoPaths: local files; resolved to public URLs via ctx.baseUrl or
 *              ctx.mapLocalPathToUrl(path). Never raw credentials here.
 *
 * ctx: {
 *   ebayAuth: string | { token, apiBase? } | { getToken: () => Promise<string>|string },
 *   baseUrl?: string,          // e.g. server.js BASE_URL — prefixes /uploads/... paths
 *   mapLocalPathToUrl?: (p: string) => string | null,
 *   http?: axios-like { put, post, get },   // injected for tests; defaults to axios
 *   marketplaceId?: string,    // default 'EBAY_US'
 *   quantity?: number,         // default 1
 *   logger?: (msg, extra?) => void,
 * }
 *
 * Failure records are shaped to be compatible with server/listing-failures.js
 * sanitizeListingFailure(): { platform, outcome:'error', error, step, status,
 * trace:[{at, message, extra}] } — extra is scrubbed before storing.
 */

import axios from 'axios';

const DEFAULT_MARKETPLACE = 'EBAY_US';
const TITLE_MAX = 80;
const HTTP_TIMEOUT = 20000;

// ---------------------------------------------------------------------------
// Pure builders (exported for tests and for reuse by other workers)
// ---------------------------------------------------------------------------

/**
 * eBay condition enum, mirroring server.js mapEbayCondition().
 * Keep in sync with server.js `mapEbayCondition` — same input vocabulary.
 */
export function mapEbayCondition(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  if (key === 'new') return 'NEW';
  if (key === 'like_new' || key === 'used_excellent') return 'USED_EXCELLENT';
  if (key === 'used_fair' || key === 'fair') return 'USED_ACCEPTABLE';
  return 'USED_GOOD';
}

const CATEGORY_RULES = [
  // apparel
  [/sneaker|shoe|boot|loafer/i, '159493'], // Athletic Shoes leaf
  [/jacket|coat|sherpa|parka|blazer/i, '11450'],
  [/hoodie|sweatshirt|crewneck/i, '11450'],
  [/shirt|tee|t-shirt|polo|flannel/i, '11450'],
  [/dress|skirt|blouse/i, '11450'],
  [/jean|pant|trouser|short|cargo/i, '11450'],
  [/bag|backpack|tote|handbag/i, '11450'],
  [/hat|cap|beanie/i, '11450'],
  [/watch\b/i, '31387'], // Wristwatches
  // music gear
  [/guitar|bass guitar|amplifier|\bamp\b|pedal|synth|keyboard|drum/i, '619'],
  // other common resale categories
  [/lego/i, '19006'],
  [/camera|lens|film camera/i, '31388'],
  [/console|controller|video game/i, '139973'],
  [/vinyl|record player|turntable/i, '619'],
];

const CATEGORY_FALLBACKS = {
  clothing: '11450',
  furniture: '11700',
  home: '11700',
  tech: '293',
  tickets: '1305',
  music: '619',
};

/**
 * Best-effort eBay category id from identity. Falls back to '1' (same as
 * server.js ebayCategoryHint) when nothing matches. Explicit identity.ebayCategoryId
 * (numeric) always wins.
 */
export function inferEbayCategoryId(identity = {}) {
  if (/^\d+$/.test(String(identity.ebayCategoryId || ''))) {
    return String(identity.ebayCategoryId);
  }
  const haystack = [identity.name, identity.model, identity.brand]
    .filter(Boolean)
    .join(' ');
  for (const [pattern, categoryId] of CATEGORY_RULES) {
    if (pattern.test(haystack)) return categoryId;
  }
  const kindRaw = identity.kind || identity.category;
  if (kindRaw) {
    const kind = String(kindRaw).toLowerCase();
    if (CATEGORY_FALLBACKS[kind]) return CATEGORY_FALLBACKS[kind];
  }
  return '1';
}

/**
 * eBay keyword-style title: Brand + name + year + size + color, <= 80 chars.
 */
export function buildEbayTitle(identity = {}) {
  const brand = identity.brand ? String(identity.brand).trim() : '';
  const name = identity.name || identity.model || '';
  const nameText = String(name).trim();
  // Avoid "Kith Kith Corduroy Sherpa Jacket" when name already starts with brand.
  const showBrand = brand && !nameText.toLowerCase().startsWith(brand.toLowerCase());
  const parts = [
    showBrand ? brand : null,
    nameText || null,
    identity.year || identity.season,
    identity.size,
    identity.color,
  ].filter((part) => part && String(part).trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/**
 * Plain-text description with the confirmed attributes spelled out.
 */
export function buildEbayDescription(identity = {}) {
  const rows = [
    ['Brand', identity.brand],
    ['Model', identity.model],
    ['Season', identity.year || identity.season],
    ['Size', identity.size],
    ['Color', identity.color],
    ['Condition', humanizeCondition(identity.condition)],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  const name = identity.name || [identity.brand, identity.model].filter(Boolean).join(' ');
  return (
    `${name}\n\n` +
    `${rows}\n\n` +
    `Ships within 2 business days. Please review all photos before purchasing — ` +
    `they are part of the description.`
  );
}

function humanizeCondition(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  const labels = {
    new: 'New',
    like_new: 'Like new',
    used_excellent: 'Excellent',
    used_good: 'Good',
    used_fair: 'Fair',
    fair: 'Fair',
    poor: 'For parts',
  };
  return labels[key] || 'Good';
}

// ---------------------------------------------------------------------------
// Auth + HTTP plumbing (all OAuth logic stays in server.js)
// ---------------------------------------------------------------------------

function getApiBase(ctx) {
  if (ctx?.apiBase) return ctx.apiBase;
  if (typeof ctx?.ebayAuth === 'object' && ctx.ebayAuth?.apiBase) {
    return ctx.ebayAuth.apiBase;
  }
  if (process.env.EBAY_BASE_URL) return process.env.EBAY_BASE_URL;
  return process.env.EBAY_USE_PRODUCTION === 'false'
    ? 'https://api.sandbox.ebay.com'
    : 'https://api.ebay.com';
}

async function resolveEbayToken(ctx) {
  const auth = ctx?.ebayAuth;
  if (!auth) return null;
  if (typeof auth === 'string') return auth.trim() || null;
  if (typeof auth.getToken === 'function') {
    const token = await auth.getToken();
    return token && String(token).trim() ? String(token).trim() : null;
  }
  if (typeof auth.token === 'string' && auth.token.trim()) return auth.token.trim();
  return null;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US',
  };
}

function resolveImageUrls({ photoPaths, photoUrls }, ctx = {}) {
  const direct = (photoUrls || []).filter((url) => /^https:\/\//i.test(String(url)));
  const mapped = (photoPaths || [])
    .map((p) => {
      const raw = String(p || '');
      if (/^https:\/\//i.test(raw)) return raw;
      if (typeof ctx.mapLocalPathToUrl === 'function') {
        const mappedUrl = ctx.mapLocalPathToUrl(raw);
        if (mappedUrl && /^https:\/\//i.test(mappedUrl)) return mappedUrl;
      }
      if (raw.startsWith('/uploads/') && ctx.baseUrl) {
        return `${String(ctx.baseUrl).replace(/\/$/, '')}${raw}`;
      }
      return null;
    })
    .filter(Boolean);
  return [...new Set([...direct, ...mapped])];
}

function makeTrace() {
  const steps = [];
  return {
    push(message, extra) {
      steps.push({
        at: new Date().toISOString(),
        message: String(message).slice(0, 300),
        ...(extra && typeof extra === 'object' ? { extra } : {}),
      });
    },
    list() {
      return steps;
    },
  };
}

function ebayErrorMessage(error) {
  const apiErrors = error?.response?.data?.errors;
  if (Array.isArray(apiErrors) && apiErrors[0]?.message) {
    return String(apiErrors[0].message);
  }
  return error?.message || 'Unknown eBay error';
}

function failed(step, error, trace, extra = {}) {
  return {
    ok: false,
    marketplace: 'ebay',
    status: 'failed',
    error: ebayErrorMessage(error).slice(0, 500),
    step,
    statusCode: error?.response?.status ?? null,
    code: error?.code || extra.code || null,
    // Compatible with server/listing-failures.js sanitizeListingFailure()
    failure: {
      platform: 'ebay',
      outcome: 'error',
      error: ebayErrorMessage(error).slice(0, 500),
      step,
      status: error?.response?.status ?? null,
      source: 'ebay-auto',
      trace: trace.list(),
    },
  };
}

// ---------------------------------------------------------------------------
// eBay Sell Inventory API calls
// ---------------------------------------------------------------------------

async function createInventoryItem(http, apiBase, token, sku, payload) {
  await http.put(
    `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    payload,
    { headers: authHeaders(token), timeout: HTTP_TIMEOUT }
  );
}

async function fetchAccountPolicies(http, apiBase, token, trace) {
  const load = async (path, listKey, idKey) => {
    try {
      const response = await http.get(`${apiBase}/sell/account/v1/${path}`, {
        headers: { ...authHeaders(token), 'Accept-Language': 'en-US' },
        params: { marketplace_id: DEFAULT_MARKETPLACE },
        timeout: 15000,
      });
      const list = response.data?.[listKey] || [];
      return list[0]?.[idKey] || null;
    } catch (error) {
      trace.push(`eBay ${path} fetch failed: ${ebayErrorMessage(error)}`);
      return null;
    }
  };
  const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all([
    load('fulfillment_policy', 'fulfillmentPolicies', 'fulfillmentPolicyId'),
    load('payment_policy', 'paymentPolicies', 'paymentPolicyId'),
    load('return_policy', 'returnPolicies', 'returnPolicyId'),
  ]);
  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
}

async function fetchInventoryLocation(http, apiBase, token, trace) {
  try {
    const response = await http.get(`${apiBase}/sell/inventory/v1/location`, {
      headers: authHeaders(token),
      timeout: 15000,
    });
    const locations = response.data?.locations || [];
    const enabled =
      locations.find((location) => location.merchantLocationStatus === 'ENABLED') ||
      locations[0];
    return enabled?.merchantLocationKey || null;
  } catch (error) {
    trace.push(`eBay inventory location fetch failed: ${ebayErrorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function distribute({ identity, price, photoPaths, photoUrls } = {}, ctx = {}) {
  const trace = makeTrace();
  const http = ctx.http || axios;
  const marketplaceId = ctx.marketplaceId || DEFAULT_MARKETPLACE;
  const quantity = Math.max(1, Number(ctx.quantity) || 1);
  const log = ctx.logger || (() => {});
  const cleanIdentity = identity && typeof identity === 'object' ? identity : {};

  const amount = Number(price);
  if (!Number.isFinite(amount) || amount <= 0) {
    trace.push('Invalid price rejected before any eBay call');
    return {
      ok: false,
      marketplace: 'ebay',
      status: 'failed',
      error: `Invalid price: ${String(price).slice(0, 40)}`,
      step: 'validate',
      failure: {
        platform: 'ebay',
        outcome: 'error',
        error: 'Invalid price',
        step: 'validate',
        status: null,
        source: 'ebay-auto',
        trace: trace.list(),
      },
    };
  }

  const token = await resolveEbayToken(ctx);
  if (!token) {
    trace.push('No eBay access token available (user has not connected eBay)');
    const error = new Error(
      'eBay is not connected. Connect eBay once in the dashboard (one-time global setup), then retry.'
    );
    return failed('auth', error, trace, { code: 'ebay_not_connected' });
  }

  const apiBase = getApiBase(ctx);
  const sku = `xl_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const imageUrls = resolveImageUrls({ photoPaths, photoUrls }, ctx);
  if (!imageUrls.length) {
    trace.push(
      `No usable photo URLs (got ${String(photoUrls?.length || 0)} photoUrls, ` +
        `${String(photoPaths?.length || 0)} photoPaths)`
    );
    const error = new Error(
      'eBay needs publicly reachable photo URLs (https). Provide photoUrls or configure baseUrl/mapLocalPathToUrl.'
    );
    return failed('photos', error, trace, { code: 'ebay_photos_required' });
  }
  trace.push(`Resolved ${imageUrls.length} photo URL(s)`);

  const condition = mapEbayCondition(cleanIdentity.condition);
  const categoryId = inferEbayCategoryId(cleanIdentity);
  const title = buildEbayTitle(cleanIdentity) || 'Untitled Item';
  const description = buildEbayDescription(cleanIdentity);

  try {
    trace.push('create inventory item');
    await createInventoryItem(http, apiBase, token, sku, {
      availability: { shipToLocationAvailability: { quantity } },
      condition,
      ...(condition !== 'NEW'
        ? { conditionDescription: `Pre-owned — ${humanizeCondition(cleanIdentity.condition)} condition. See photos.` }
        : {}),
      product: {
        title,
        description,
        imageUrls,
      },
    });
    log('eBay inventory item created', { sku });

    trace.push('fetch account policies + inventory location');
    const [policies, merchantLocationKey] = await Promise.all([
      fetchAccountPolicies(http, apiBase, token, trace),
      fetchInventoryLocation(http, apiBase, token, trace),
    ]);
    if (!policies.fulfillmentPolicyId || !policies.paymentPolicyId || !policies.returnPolicyId) {
      const error = new Error(
        'eBay needs shipping, return, and payment policies set up in Seller Hub before listing (one-time global setup)'
      );
      error.code = 'ebay_policies_required';
      throw error;
    }
    if (!merchantLocationKey) {
      const error = new Error(
        'eBay needs an inventory location in Seller Hub before listing (one-time global setup)'
      );
      error.code = 'ebay_location_required';
      throw error;
    }

    trace.push('create offer');
    const offerResponse = await http.post(
      `${apiBase}/sell/inventory/v1/offer`,
      {
        sku,
        marketplaceId,
        format: 'FIXED_PRICE',
        availableQuantity: quantity,
        categoryId,
        merchantLocationKey,
        listingPolicies: {
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId: policies.paymentPolicyId,
          returnPolicyId: policies.returnPolicyId,
        },
        pricingSummary: {
          price: { value: amount.toFixed(2), currency: 'USD' },
        },
      },
      { headers: authHeaders(token), timeout: HTTP_TIMEOUT }
    );

    const offerId = offerResponse.data?.offerId;
    if (!offerId) {
      const error = new Error('eBay returned no offerId when creating the offer');
      throw error;
    }

    trace.push('publish offer');
    const published = await http.post(
      `${apiBase}/sell/inventory/v1/offer/${offerId}/publish`,
      {},
      { headers: authHeaders(token), timeout: HTTP_TIMEOUT }
    );

    const listingId = published.data?.listingId || sku;
    const url = `https://www.ebay.com/itm/${listingId}`;
    trace.push(`listed as ${listingId}`);
    log('eBay listing published', { listingId, url });

    return {
      ok: true,
      marketplace: 'ebay',
      status: 'listed',
      externalId: String(listingId),
      url,
      trace: trace.list(),
    };
  } catch (error) {
    const step = error?.code === 'ebay_policies_required' || error?.code === 'ebay_location_required'
      ? 'policies'
      : trace.list().at(-1)?.message || 'ebay-api';
    return failed(step, error, trace);
  }
}

export default { distribute, mapEbayCondition, inferEbayCategoryId, buildEbayTitle, buildEbayDescription };
