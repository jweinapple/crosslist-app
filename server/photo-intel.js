/**
 * photo-intel.js — Photo intelligence for the crosslist app.
 *
 * Target user flow (photos-only):
 *   1. User uploads ONLY photos (POST /api/uploads).
 *   2. identifyProduct() reads the photos and extracts the EXACT product
 *      (brand, model/name, size, color, condition) via a vision model,
 *      with per-field confidence scores.
 *   3. suggestPrice() looks up eBay sold-listing comps (Buy Browse API,
 *      item_sales/search) and derives a market price (median of comps).
 *   4. The app shows ONE confirmation screen
 *      ("Is this <exact product> at $<price>?") — the user confirms or
 *      corrects. Only then does auto-distribution happen.
 *
 * Design rules:
 *   - NEVER fabricate attributes or comps. If a credential is missing, the
 *     vision path throws MissingCredentialError naming the exact env var.
 *     The pricing path degrades to { price: null, comps: [], rationale }
 *     with a rationale that says exactly why comps are unavailable — the
 *     confirmation screen is the designed place for the user to correct it.
 *   - Grailed has NO public API (verified Oct 2026) — see
 *     GRAILED_PRICING_OPTIONS for the documented options. We do not scrape
 *     or use unofficial Grailed endpoints.
 *   - The vision provider is a seam: VISION_PROVIDER selects the provider
 *     ('openai' today = OpenAI-compatible chat-completions vision; point
 *     VISION_BASE_URL at any OpenAI-compatible gateway such as OpenRouter).
 *     To add a provider: implement a class with an async
 *     identify(photoDataUrls, opts) method returning the identity JSON
 *     below, add it to SUPPORTED_VISION_PROVIDERS, and wire it in
 *     createVisionProvider().
 *
 * Env vars:
 *   VISION_PROVIDER  - vision provider name (default 'openai')
 *   VISION_API_KEY   - API key for the vision provider (REQUIRED for identifyProduct)
 *   VISION_MODEL     - model name (default 'gpt-4o-mini')
 *   VISION_BASE_URL  - override the chat-completions base URL (default https://api.openai.com/v1)
 *   EBAY_CLIENT_ID / EBAY_CLIENT_SECRET
 *                    - eBay developer app credentials, used ONLY for a
 *                      read-only client_credentials application token to call
 *                      the Buy Browse API. Get them at https://developer.ebay.com/my/keys.
 *                      (Same app credentials the app already uses for OAuth;
 *                      reuse read-only — no user OAuth needed for public sold data.)
 *   EBAY_USE_PRODUCTION - 'false' to use the eBay sandbox endpoints.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a required credential env var is not configured. */
export class MissingCredentialError extends Error {
  constructor(varName, hint) {
    super(`Missing required credential: ${varName}. ${hint || ''}`.trim());
    this.name = 'MissingCredentialError';
    this.varName = varName;
  }
}

/** Thrown for vision-provider failures (transport, auth, malformed response). */
export class VisionProviderError extends Error {
  constructor(provider, message, cause) {
    super(`Vision provider "${provider}" failed: ${message}`);
    this.name = 'VisionProviderError';
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown for hard pricing-pipeline failures (reserved; suggestPrice degrades
 *  gracefully to { price: null, comps: [], rationale } instead of throwing on
 *  missing credentials or API errors so the confirmation screen stays alive). */
export class PricingError extends Error {
  constructor(source, message, cause) {
    super(`Pricing source "${source}" failed: ${message}`);
    this.name = 'PricingError';
    this.source = source;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Vision provider seam
// ---------------------------------------------------------------------------

export const SUPPORTED_VISION_PROVIDERS = ['openai'];

export const DEFAULT_VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';
export const DEFAULT_VISION_BASE_URL =
  process.env.VISION_BASE_URL || 'https://api.openai.com/v1';

const IDENTITY_FIELDS = ['brand', 'model', 'name', 'size', 'color', 'condition'];

const CONDITION_VALUES = new Set([
  'new with tags',
  'like new',
  'excellent',
  'good',
  'fair',
  'poor',
  'unknown',
]);

/** Resolve the provider name from opts/env; throws VisionProviderError if unknown. */
export function getVisionProviderName(opts = {}) {
  const name = String(opts.provider ?? process.env.VISION_PROVIDER ?? 'openai')
    .toLowerCase()
    .trim();
  if (!SUPPORTED_VISION_PROVIDERS.includes(name)) {
    throw new VisionProviderError(
      name,
      `Unsupported VISION_PROVIDER "${name}". Supported: ${SUPPORTED_VISION_PROVIDERS.join(', ')}.`
    );
  }
  return name;
}

/**
 * Build a vision provider instance. Throws MissingCredentialError naming the
 * exact env var when no key is configured — never returns a stub that would
 * fabricate attributes.
 */
export function createVisionProvider(opts = {}) {
  const provider = getVisionProviderName(opts);
  const apiKey = opts.apiKey ?? process.env.VISION_API_KEY;
  if (!apiKey) {
    throw new MissingCredentialError(
      'VISION_API_KEY',
      'Set VISION_API_KEY to an API key for your vision provider to enable ' +
        'photo identification (e.g. export VISION_API_KEY=sk-...). ' +
        'Get a key at https://platform.openai.com/api-keys. ' +
        'Optional: VISION_PROVIDER (default "openai"), VISION_MODEL ' +
        `(default "${DEFAULT_VISION_MODEL}"), VISION_BASE_URL for an ` +
        'OpenAI-compatible gateway (e.g. https://openrouter.ai/api/v1).'
    );
  }
  if (provider === 'openai') {
    return new OpenAICompatibleVisionProvider({
      apiKey,
      model: opts.model ?? DEFAULT_VISION_MODEL,
      baseUrl: opts.baseUrl ?? DEFAULT_VISION_BASE_URL,
      http: opts.http,
    });
  }
  // Unreachable while SUPPORTED_VISION_PROVIDERS only lists 'openai'; kept
  // explicit so adding a provider forces a case here.
  throw new VisionProviderError(provider, 'No implementation registered.');
}

const IDENTITY_SYSTEM_PROMPT = `You are a product-identification model for a resale listing assistant.
All photos show the SAME physical item from different angles. Read every visible tag, label, logo, and hardware marking.
Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:
{
  "brand": string|null,      // brand / label read from tags or logos, e.g. "Kith"
  "model": string|null,      // product line / style name, e.g. "FW2022 Corduroy Sherpa Trucker Jacket"
  "name": string|null,       // full display name: brand + model, e.g. "Kith FW2022 Corduroy Sherpa Trucker Jacket"
  "size": string|null,       // size read from the tag, e.g. "XL"
  "color": string|null,       // dominant colorway in plain words, e.g. "Light Blue"
  "condition": string|null,   // one of: "new with tags" | "like new" | "excellent" | "good" | "fair" | "poor" | "unknown"
  "confidence": { "brand": 0..1, "model": 0..1, "name": 0..1, "size": 0..1, "color": 0..1, "condition": 0..1 },
  "notes": string             // what you observed: tag text, logos, hardware, visible wear
}
Rules:
- Prefer reading tags over guessing. Never invent a model number or style name you cannot see.
- A visible hang tag or pristine tags attached => "new with tags". Obvious wear or none visible => judge honestly, else "unknown".
- Use null (with low confidence) for any field you cannot determine; do not guess.
- confidence is your per-field certainty from 0 (guessing) to 1 (read it directly off a tag).`;

const IDENTITY_USER_PROMPT = `Identify this exact product for resale. Return ONLY the JSON object described in the system prompt.`;

/**
 * OpenAI-compatible chat-completions vision provider (works with OpenAI and
 * any OpenAI-compatible gateway via VISION_BASE_URL).
 */
export class OpenAICompatibleVisionProvider {
  constructor({ apiKey, model, baseUrl, http } = {}) {
    if (!apiKey) {
      throw new MissingCredentialError(
        'VISION_API_KEY',
        'An API key is required to construct the vision provider.'
      );
    }
    this.apiKey = apiKey;
    this.model = model || DEFAULT_VISION_MODEL;
    this.baseUrl = (baseUrl || DEFAULT_VISION_BASE_URL).replace(/\/+$/, '');
    this.http = http || axios;
  }

  /**
   * @param {string[]} photoDataUrls - data: URLs (image/jpeg, image/png, image/webp, image/gif)
   * @returns {Promise<object>} the parsed identity JSON from the model
   */
  async identify(photoDataUrls, opts = {}) {
    if (!Array.isArray(photoDataUrls) || photoDataUrls.length === 0) {
      throw new VisionProviderError('openai', 'At least one photo data URL is required.');
    }
    let res;
    try {
      res = await this.http.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          temperature: 0,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: IDENTITY_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: IDENTITY_USER_PROMPT },
                ...photoDataUrls.map((url) => ({
                  type: 'image_url',
                  image_url: { url, detail: 'high' },
                })),
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: opts.timeoutMs ?? 90000,
        }
      );
    } catch (err) {
      const status = err?.response?.status;
      const detail =
        err?.response?.data?.error?.message || err?.message || 'unknown transport error';
      throw new VisionProviderError(
        'openai',
        status ? `HTTP ${status}: ${detail}` : detail,
        err
      );
    }
    const text = res?.data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new VisionProviderError('openai', 'Empty response from the vision model.');
    }
    return parseIdentityJson(text);
  }
}

/** Parse the model's raw text into identity JSON; throws VisionProviderError on failure. */
export function parseIdentityJson(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new VisionProviderError(
      'openai',
      `Model did not return valid JSON: ${err.message}`,
      err
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VisionProviderError('openai', 'Model returned a non-object JSON payload.');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Photo loading
// ---------------------------------------------------------------------------

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const CONVERTIBLE_EXT = new Set(['.heic', '.heif']);
const MAX_INPUT_PHOTOS = 6;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function extOf(photoPath) {
  return path.extname(String(photoPath)).toLowerCase();
}

/**
 * Read a photo and return a data: URL the vision API can consume.
 * Accepts a local file path or an http(s) URL (e.g. a Vercel Blob photo —
 * resolveAutoListPhotos passes Blob URLs through, and the bytes are fetched
 * here so the vision step works with no local disk).
 */
export async function loadPhotoAsDataUrl(photoPath) {
  const source = String(photoPath || '');
  let buffer;
  let headerMime = '';
  if (/^https?:\/\//i.test(source)) {
    let res;
    try {
      res = await axios.get(source, {
        responseType: 'arraybuffer',
        maxBodyLength: MAX_PHOTO_BYTES + 1,
        maxContentLength: MAX_PHOTO_BYTES + 1,
        timeout: 30000,
      });
    } catch (err) {
      throw new VisionProviderError('openai', `Cannot fetch photo "${source}": ${err.message}`, err);
    }
    buffer = Buffer.from(res.data);
    headerMime = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  } else {
    buffer = await readFile(source).catch((err) => {
      throw new VisionProviderError('openai', `Cannot read photo "${source}": ${err.message}`, err);
    });
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new VisionProviderError(
      'openai',
      `Photo "${source}" is ${(buffer.length / 1048576).toFixed(1)}MB; keep photos under 10MB.`
    );
  }
  const ext = extOf(source.split(/[?#]/)[0]);
  if (CONVERTIBLE_EXT.has(ext)) {
    // iPhone uploads may be HEIC; convert to JPEG for vision APIs.
    let convert;
    try {
      ({ default: convert } = await import('heic-convert'));
    } catch (err) {
      throw new VisionProviderError(
        'openai',
        `Photo "${source}" is HEIC but heic-convert is unavailable. Export it as JPEG and try again.`,
        err
      );
    }
    const jpeg = await convert({ buffer, format: 'JPEG', quality: 0.92 });
    return `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
  }
  const knownHeaderMime = Object.values(MIME_BY_EXT).includes(headerMime) ? headerMime : '';
  const mime = MIME_BY_EXT[ext] || knownHeaderMime;
  if (!mime) {
    throw new VisionProviderError(
      'openai',
      `Photo "${source}" has unsupported extension "${ext || '(none)'}". ` +
        `Supported: ${[...Object.keys(MIME_BY_EXT), ...CONVERTIBLE_EXT].join(', ')}.`
    );
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// identifyProduct
// ---------------------------------------------------------------------------

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalizeIdentity(parsed) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    identity[field] = cleanString(parsed[field]);
  }
  if (identity.condition && !CONDITION_VALUES.has(identity.condition.toLowerCase())) {
    identity.condition = 'unknown';
  } else if (identity.condition) {
    identity.condition = identity.condition.toLowerCase();
  }
  const rawConfidence =
    parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {};
  const confidence = {};
  for (const field of IDENTITY_FIELDS) {
    confidence[field] = clamp01(rawConfidence[field]);
  }
  return { identity, confidence };
}

/**
 * Identify the exact product shown in the given photos.
 *
 * @param {string[]} photoPaths - filesystem paths to the item photos (all angles of one item)
 * @param {object} [opts]
 * @param {object} [opts.providerInstance] - pre-built vision provider (used by tests / DI)
 * @param {string} [opts.provider] - provider name override (default from VISION_PROVIDER)
 * @param {string} [opts.apiKey] - API key override (default from VISION_API_KEY)
 * @returns {Promise<{brand, model, name, size, color, condition, confidence, raw}>}
 * @throws {MissingCredentialError} when VISION_API_KEY is not configured
 * @throws {VisionProviderError} on photo-load or provider failures
 */
export async function identifyProduct(photoPaths, opts = {}) {
  if (!Array.isArray(photoPaths) || photoPaths.length === 0) {
    throw new VisionProviderError('openai', 'identifyProduct requires at least one photo path.');
  }
  if (photoPaths.length > MAX_INPUT_PHOTOS) {
    throw new VisionProviderError(
      'openai',
      `Too many photos (${photoPaths.length}); the limit is ${MAX_INPUT_PHOTOS}.`
    );
  }
  const provider = opts.providerInstance || createVisionProvider(opts);
  const dataUrls = [];
  for (const p of photoPaths) {
    dataUrls.push(await loadPhotoAsDataUrl(p));
  }
  const parsed = await provider.identify(dataUrls, opts);
  const { identity, confidence } = normalizeIdentity(parsed);
  return { ...identity, confidence, raw: parsed };
}

// ---------------------------------------------------------------------------
// suggestPrice — eBay sold comps
// ---------------------------------------------------------------------------

export const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';

function resolveEbayAppConfig(opts = {}) {
  const ebayOpts = opts.ebay || {};
  const useSandbox = process.env.EBAY_USE_PRODUCTION === 'false';
  return {
    clientId: ebayOpts.clientId ?? process.env.EBAY_CLIENT_ID ?? '',
    clientSecret: ebayOpts.clientSecret ?? process.env.EBAY_CLIENT_SECRET ?? '',
    authBase:
      ebayOpts.authBase ??
      process.env.EBAY_AUTH_BASE_URL ??
      (useSandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com'),
    apiBase:
      ebayOpts.apiBase ??
      process.env.EBAY_BASE_URL ??
      (useSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'),
    marketplaceId: opts.marketplaceId || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    limit: Math.min(50, Math.max(1, Number(opts.compLimit) || 25)),
  };
}

// Module-level app-token cache (keyed by clientId|authBase). Read-only
// client_credentials tokens are good for ~2h; refresh a minute early.
const ebayAppTokenCache = new Map();

/** Test hook: clear the cached eBay application tokens. */
export function _resetEbayTokenCache() {
  ebayAppTokenCache.clear();
}

async function getEbayAppToken({ clientId, clientSecret, authBase }, http) {
  const key = `${clientId}|${authBase}`;
  const cached = ebayAppTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  let res;
  try {
    res = await http.post(
      `${authBase}/identity/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: EBAY_OAUTH_SCOPE,
      }),
      {
        auth: { username: clientId, password: clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    throw new PricingError(
      'eBay',
      `application token request failed${status ? ` (HTTP ${status})` : ''}: ` +
        `${err?.response?.data?.error_description || err.message}. ` +
        'Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET at https://developer.ebay.com/my/keys.',
      err
    );
  }
  const { access_token, expires_in } = res?.data || {};
  if (!access_token) {
    throw new PricingError('eBay', 'Token endpoint returned no access_token.');
  }
  const expiresAt = Date.now() + (Number(expires_in) || 7200) * 1000 - 60000;
  ebayAppTokenCache.set(key, { token: access_token, expiresAt });
  return access_token;
}

/**
 * Build the keyword query used for comp lookup from an identity.
 * Exported so tests and the confirmation UI can show/adjust it.
 */
export function buildCompQuery(identity = {}) {
  const parts = [identity.brand, identity.model, identity.color, identity.size]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return parts.join(' ').slice(0, 140);
}

/**
 * Search eBay's sold-items endpoint (Buy Browse API, item_sales/search).
 * Docs: https://developer.ebay.com/api-docs/buy/browse/resources/item_sales/methods/search
 * Note: eBay's official sold history covers roughly the last 90 days.
 */
async function searchEbaySoldComps({ token, apiBase, marketplaceId, query, limit }, http) {
  let res;
  try {
    res = await http.get(`${apiBase}/buy/browse/v1/item_sales/search`, {
      params: { q: query, limit, sort: '-soldDate' },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  } catch (err) {
    const status = err?.response?.status;
    const errors = err?.response?.data?.errors;
    const detail = errors?.[0]?.message || err.message;
    throw new PricingError(
      'eBay',
      `sold-items search failed${status ? ` (HTTP ${status})` : ''}: ${detail}. ` +
        'If HTTP 403, the eBay developer app may need approval for the sold-items ' +
        '(item_sales) endpoint — apply at https://developer.ebay.com.',
      err
    );
  }
  const items = res?.data?.itemSales;
  if (!Array.isArray(items)) return [];
  return items.map(toComp).filter(Boolean);
}

/** Map one eBay ItemSaleSummary to our comp shape (defensive field reads). */
function toComp(item) {
  const priceObj = item?.lastSoldPrice || item?.price || {};
  const soldPrice = Number(priceObj.value);
  if (!Number.isFinite(soldPrice) || soldPrice <= 0) return null;
  const comp = {
    source: 'eBay',
    title: String(item.title || '').trim() || '(untitled listing)',
    soldPrice: Math.round(soldPrice * 100) / 100,
    soldDate: item.lastSoldDate || item.soldDate || null,
  };
  const url = item.itemWebUrl || item.itemHref;
  if (url) comp.url = String(url);
  return comp;
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value * 100) / 100;
}

const NO_CREDENTIALS_NOTE =
  'Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (from https://developer.ebay.com/my/keys) ' +
  'to enable automatic eBay sold-comps. Until then, confirm or enter the price manually ' +
  'on the confirmation screen.';

const NO_API_FALLBACK_NOTE =
  'The confirmation screen remains the source of truth: confirm or correct the price there.';

/**
 * Suggest a market price for an identified product from eBay sold comps.
 *
 * Honest default: this function NEVER fabricates a price or comps. When comps
 * are unavailable (no eBay credentials, no matching sold listings, or an API
 * error), it resolves with { price: null, comps: [], rationale } where the
 * rationale says exactly why — so the UI can ask the user to set the price.
 *
 * @param {object} identity - result of identifyProduct() ({brand, model, name, size, color, condition})
 * @param {object} [opts]
 * @param {object} [opts.http] - axios-compatible client (tests / DI)
 * @param {object} [opts.ebay] - { clientId, clientSecret, authBase, apiBase } overrides
 * @param {number} [opts.compLimit] - max comps to fetch (default 25)
 * @param {string} [opts.marketplaceId] - eBay marketplace (default 'EBAY_US')
 * @returns {Promise<{price: number|null, currency: 'USD', comps: Array<{source,title,soldPrice,soldDate,url?}>, rationale: string}>}
 */
export async function suggestPrice(identity, opts = {}) {
  const http = opts.http || axios;
  const cfg = resolveEbayAppConfig(opts);
  const query = buildCompQuery(identity);

  if (!query) {
    return {
      price: null,
      currency: 'USD',
      comps: [],
      rationale:
        'No product identity to price from (brand/model were all empty). ' + NO_API_FALLBACK_NOTE,
    };
  }

  if (!cfg.clientId || !cfg.clientSecret) {
    return {
      price: null,
      currency: 'USD',
      comps: [],
      rationale:
        `No sold comps available for "${query}": eBay API credentials are not configured. ` +
        NO_CREDENTIALS_NOTE,
    };
  }

  let comps;
  try {
    const token = await getEbayAppToken(cfg, http);
    comps = await searchEbaySoldComps({ ...cfg, query, token }, http);
  } catch (err) {
    const reason = err instanceof PricingError ? err.message : String(err?.message || err);
    return {
      price: null,
      currency: 'USD',
      comps: [],
      rationale:
        `No sold comps available for "${query}": ${reason} ${NO_API_FALLBACK_NOTE}`,
    };
  }

  if (comps.length === 0) {
    return {
      price: null,
      currency: 'USD',
      comps: [],
      rationale:
        `No sold listings found on eBay for "${query}" in the last ~90 days. ` +
        'Try a broader confirmation-screen correction or check current asking prices manually. ' +
        NO_API_FALLBACK_NOTE,
    };
  }

  const prices = comps.map((c) => c.soldPrice);
  const price = median(prices);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    price,
    currency: 'USD',
    comps,
    rationale:
      `Based on ${comps.length} eBay sold comp${comps.length === 1 ? '' : 's'} ` +
      `for "${query}": median $${price.toFixed(2)} ` +
      `(range $${min.toFixed(2)}–$${max.toFixed(2)}), newest sales first.`,
  };
}

// ---------------------------------------------------------------------------
// Grailed pricing options (documented, crisp)
// ---------------------------------------------------------------------------

/**
 * Grailed publishes NO public developer API (verified Oct 2026). These are the
 * options for streetwear-heavy comps, in recommended order. Only the eBay path
 * is implemented; the confirmation screen is the designed manual fallback.
 */
export const GRAILED_PRICING_OPTIONS = [
  {
    id: 'ebay-comps-proxy',
    status: 'implemented',
    title: 'eBay sold comps (default)',
    summary:
      'Use eBay sold-listing data (Browse API item_sales/search) as the comp source. ' +
      'Free with an eBay developer app; ~90 days of official sold history. ' +
      'Streetwear (Kith, Supreme, etc.) has strong sell-through on eBay, so comps ' +
      'are usually representative.',
  },
  {
    id: 'confirmation-screen-correction',
    status: 'by-design',
    title: 'User-corrected price on the confirmation screen',
    summary:
      'The flow already requires one confirmation screen ("Is this <product> at $<price>?"). ' +
      'When comps are missing or low-confidence, the user corrects the price there. ' +
      'This is the canonical fallback — it needs no extra integration.',
  },
  {
    id: 'third-party-pricing-data',
    status: 'optional',
    title: 'Third-party pricing data (paid)',
    summary:
      'Subscribe to a pricing-data provider (e.g. Apify Grailed scraper actors, ' +
      'Terapeak via eBay Seller Hub) and add a comps-provider adapter here. ' +
      'Adds cost and another credential; only worth it if eBay comps prove thin ' +
      'for Jeremy\u2019s categories.',
  },
  {
    id: 'grailed-unofficial-api',
    status: 'not-used',
    title: 'Unofficial Grailed endpoints (deliberately not used)',
    summary:
      'Grailed has no public API. Unofficial routes exist (the site\u2019s own ' +
      'Algolia-backed search endpoints, third-party scraping actors), but they are ' +
      'undocumented, break without notice, and sit behind bot mitigation. ' +
      'We do not use them.',
  },
];
