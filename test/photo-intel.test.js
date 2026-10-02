import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  GRAILED_PRICING_OPTIONS,
  MissingCredentialError,
  VisionProviderError,
  _resetEbayTokenCache,
  buildCompQuery,
  createVisionProvider,
  getVisionProviderName,
  identifyProduct,
  loadPhotoAsDataUrl,
  parseIdentityJson,
  suggestPrice,
} from '../server/photo-intel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 1x1 red PNG — just needs to be a decodable file with a supported extension.
const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const dataDir = mkdtempSync(path.join(tmpdir(), 'crosslist-photo-intel-'));
const photoPath = path.join(dataDir, 'jacket.png');
writeFileSync(photoPath, Buffer.from(ONE_PX_PNG_BASE64, 'base64'));

after(() => rmSync(dataDir, { recursive: true, force: true }));

// What a vision model should return for the acceptance-test Kith jacket photos
// (tag in photo 1 reads KITH / FW2022 / XL; light-blue corduroy sherpa trucker).
const KITH_VISION_RESPONSE = {
  brand: 'Kith',
  model: 'FW2022 Corduroy Sherpa Trucker Jacket',
  name: 'Kith FW2022 Corduroy Sherpa Trucker Jacket',
  size: 'XL',
  color: 'Light Blue',
  condition: 'new with tags',
  confidence: {
    brand: 0.99,
    model: 0.8,
    name: 0.85,
    size: 0.98,
    color: 0.9,
    condition: 0.85,
  },
  notes: 'Tag reads KITH / FW2022 / XL; Kith-branded snap buttons; sherpa collar and lining.',
};

/** Stub vision provider: asserts it got data URLs, returns the canned response. */
function stubVisionProvider(payload, seen = {}) {
  return {
    async identify(photoDataUrls) {
      seen.count = (seen.count || 0) + 1;
      seen.photoCount = photoDataUrls.length;
      assert.ok(
        photoDataUrls.every((u) => u.startsWith('data:image/')),
        'provider must receive data URLs'
      );
      // Return a deep copy so tests can't observe mutation.
      return JSON.parse(JSON.stringify(payload));
    },
  };
}

function withCleanVisionEnv(fn) {
  const saved = {
    VISION_PROVIDER: process.env.VISION_PROVIDER,
    VISION_API_KEY: process.env.VISION_API_KEY,
    VISION_MODEL: process.env.VISION_MODEL,
    VISION_BASE_URL: process.env.VISION_BASE_URL,
  };
  delete process.env.VISION_PROVIDER;
  delete process.env.VISION_API_KEY;
  delete process.env.VISION_MODEL;
  delete process.env.VISION_BASE_URL;
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withCleanEbayEnv(fn) {
  const saved = {
    EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
    EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
    EBAY_USE_PRODUCTION: process.env.EBAY_USE_PRODUCTION,
  };
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
  delete process.env.EBAY_USE_PRODUCTION;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// identifyProduct
// ---------------------------------------------------------------------------

test('identifyProduct maps a stubbed vision response to the Kith jacket attributes', async () => {
  const seen = {};
  const result = await identifyProduct([photoPath], {
    providerInstance: stubVisionProvider(KITH_VISION_RESPONSE, seen),
  });
  assert.equal(seen.count, 1);
  assert.equal(seen.photoCount, 1);
  assert.equal(result.brand, 'Kith');
  assert.equal(result.model, 'FW2022 Corduroy Sherpa Trucker Jacket');
  assert.equal(result.name, 'Kith FW2022 Corduroy Sherpa Trucker Jacket');
  assert.equal(result.size, 'XL');
  assert.equal(result.color, 'Light Blue');
  assert.equal(result.condition, 'new with tags');
  for (const field of ['brand', 'model', 'name', 'size', 'color', 'condition']) {
    const c = result.confidence[field];
    assert.ok(typeof c === 'number' && c >= 0 && c <= 1, `confidence.${field} in 0..1`);
  }
  assert.equal(result.confidence.size, 0.98);
  assert.ok(result.raw && typeof result.raw === 'object');
});

test('identifyProduct clamps out-of-range confidence and nulls blank fields', async () => {
  const result = await identifyProduct([photoPath], {
    providerInstance: stubVisionProvider({
      brand: '  Kith  ',
      model: '',
      name: null,
      size: 'XL',
      color: 'Light Blue',
      condition: 'weird value',
      confidence: { brand: 5, model: -2, size: 'high' },
      notes: '',
    }),
  });
  assert.equal(result.brand, 'Kith'); // trimmed
  assert.equal(result.model, null); // blank -> null
  assert.equal(result.condition, 'unknown'); // not in the allowlist
  assert.equal(result.confidence.brand, 1); // clamped
  assert.equal(result.confidence.model, 0); // clamped / non-numeric
});

test('identifyProduct rejects empty photo lists and bad extensions', async () => {
  await assert.rejects(() => identifyProduct([]), VisionProviderError);
  const badPath = path.join(dataDir, 'notes.txt');
  writeFileSync(badPath, 'not an image');
  await assert.rejects(
    () =>
      identifyProduct([badPath], {
        providerInstance: stubVisionProvider(KITH_VISION_RESPONSE),
      }),
    /unsupported extension/
  );
});

test('loadPhotoAsDataUrl returns a data URL for supported formats', async () => {
  const url = await loadPhotoAsDataUrl(photoPath);
  assert.ok(url.startsWith('data:image/png;base64,'));
});

test('parseIdentityJson strips code fences and rejects garbage', () => {
  const parsed = parseIdentityJson('```json\n{"brand":"Kith"}\n```');
  assert.equal(parsed.brand, 'Kith');
  assert.throws(() => parseIdentityJson('not json at all'), VisionProviderError);
});

// ---------------------------------------------------------------------------
// Credential seam
// ---------------------------------------------------------------------------

test('createVisionProvider throws MissingCredentialError when VISION_API_KEY is unset', () => {
  withCleanVisionEnv(() => {
    assert.throws(
      () => createVisionProvider(),
      (err) =>
        err instanceof MissingCredentialError &&
        err.varName === 'VISION_API_KEY' &&
        /VISION_API_KEY/.test(err.message) &&
        /platform\.openai\.com/.test(err.message)
    );
  });
});

test('createVisionProvider builds a provider when the key is set', () => {
  withCleanVisionEnv(() => {
    process.env.VISION_API_KEY = 'sk-test-key';
    const provider = createVisionProvider();
    assert.ok(typeof provider.identify === 'function');
    assert.equal(provider.model, 'gpt-4o-mini');
  });
});

test('getVisionProviderName rejects unknown providers', () => {
  assert.throws(() => getVisionProviderName({ provider: 'telepathy' }), VisionProviderError);
  assert.equal(getVisionProviderName({}), 'openai');
});

// ---------------------------------------------------------------------------
// suggestPrice
// ---------------------------------------------------------------------------

const KITH_IDENTITY = {
  brand: 'Kith',
  model: 'FW2022 Corduroy Sherpa Trucker Jacket',
  name: 'Kith FW2022 Corduroy Sherpa Trucker Jacket',
  size: 'XL',
  color: 'Light Blue',
  condition: 'new with tags',
};

function ebayHttpStub(itemSales) {
  const calls = { token: 0, search: 0, lastQuery: null };
  return {
    calls,
    async post(url) {
      assert.match(url, /oauth2\/token$/);
      calls.token += 1;
      return { data: { access_token: 'app-token-123', expires_in: 7200 } };
    },
    async get(url, config) {
      assert.match(url, /item_sales\/search$/);
      calls.search += 1;
      calls.lastQuery = config.params.q;
      assert.equal(config.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
      assert.equal(config.params.sort, '-soldDate');
      return { data: { itemSales } };
    },
  };
}

function soldItem(title, value, soldDate) {
  return {
    title,
    lastSoldPrice: { value: String(value), currency: 'USD' },
    lastSoldDate: soldDate,
    itemWebUrl: 'https://www.ebay.com/itm/123456',
  };
}

beforeEach(() => _resetEbayTokenCache());

test('buildCompQuery composes brand/model/color/size keywords', () => {
  assert.equal(
    buildCompQuery(KITH_IDENTITY),
    'Kith FW2022 Corduroy Sherpa Trucker Jacket Light Blue XL'
  );
});

test('suggestPrice returns median price + comps from eBay sold listings', async () => {
  const http = ebayHttpStub([
    soldItem('Kith Corduroy Sherpa Trucker Jacket FW22 Blue XL', 250, '2026-09-20T10:00:00Z'),
    soldItem('KITH Sherpa Corduroy Trucker Light Blue XL FW2022', 220, '2026-09-12T10:00:00Z'),
    soldItem('Kith FW22 Corduroy Sherpa Jacket Mens XL', 280, '2026-08-30T10:00:00Z'),
  ]);
  const result = await withCleanEbayEnv(() =>
    suggestPrice(KITH_IDENTITY, {
      http,
      ebay: { clientId: 'id-1', clientSecret: 'secret-1' },
    })
  );
  assert.equal(http.calls.token, 1);
  assert.equal(http.calls.search, 1);
  assert.ok(http.calls.lastQuery.includes('Kith'));
  assert.equal(result.currency, 'USD');
  assert.equal(result.price, 250); // median of 220, 250, 280
  assert.equal(result.comps.length, 3);
  for (const comp of result.comps) {
    assert.equal(comp.source, 'eBay');
    assert.ok(typeof comp.title === 'string' && comp.title.length > 0);
    assert.ok(typeof comp.soldPrice === 'number' && comp.soldPrice > 0);
    assert.ok(typeof comp.soldDate === 'string');
    assert.ok(typeof comp.url === 'string');
  }
  assert.match(result.rationale, /3 eBay sold comps/);
  assert.match(result.rationale, /\$250\.00/);
});

test('suggestPrice degrades honestly when eBay credentials are missing', async () => {
  const result = await withCleanEbayEnv(() =>
    suggestPrice(KITH_IDENTITY, { http: ebayHttpStub([]) })
  );
  assert.equal(result.price, null);
  assert.equal(result.currency, 'USD');
  assert.deepEqual(result.comps, []);
  assert.match(result.rationale, /EBAY_CLIENT_ID/);
  assert.match(result.rationale, /not configured/);
});

test('suggestPrice returns null price (no fabricated comps) when nothing sold', async () => {
  const http = ebayHttpStub([]);
  const result = await withCleanEbayEnv(() =>
    suggestPrice(KITH_IDENTITY, {
      http,
      ebay: { clientId: 'id-2', clientSecret: 'secret-2' },
    })
  );
  assert.equal(result.price, null);
  assert.deepEqual(result.comps, []);
  assert.match(result.rationale, /No sold listings found/);
});

test('suggestPrice degrades honestly when the eBay API errors', async () => {
  const http = ebayHttpStub([]);
  http.get = async () => {
    const err = new Error('Request failed');
    err.response = { status: 403, data: { errors: [{ message: 'Forbidden' }] } };
    throw err;
  };
  const result = await withCleanEbayEnv(() =>
    suggestPrice(KITH_IDENTITY, {
      http,
      ebay: { clientId: 'id-3', clientSecret: 'secret-3' },
    })
  );
  assert.equal(result.price, null);
  assert.deepEqual(result.comps, []);
  assert.match(result.rationale, /403/);
});

test('GRAILED_PRICING_OPTIONS documents that Grailed has no public API', () => {
  assert.ok(Array.isArray(GRAILED_PRICING_OPTIONS) && GRAILED_PRICING_OPTIONS.length >= 3);
  const unofficial = GRAILED_PRICING_OPTIONS.find((o) => o.id === 'grailed-unofficial-api');
  assert.ok(unofficial);
  assert.equal(unofficial.status, 'not-used');
  assert.match(unofficial.summary, /no public API/i);
});
