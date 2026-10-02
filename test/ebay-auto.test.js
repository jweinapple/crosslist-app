import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEbayDescription,
  buildEbayTitle,
  distribute,
  inferEbayCategoryId,
  mapEbayCondition,
} from '../server/ebay-auto.js';

// Sample: Kith corduroy sherpa jacket, FW2022, XL
const SAMPLE_IDENTITY = {
  brand: 'Kith',
  model: 'Corduroy Sherpa Jacket',
  name: 'Kith Corduroy Sherpa Jacket',
  year: 'FW2022',
  size: 'XL',
  color: 'Brown',
  condition: 'like_new',
};

const API_BASE = 'https://api.sandbox.ebay.com';

function mockHttp(overrides = {}) {
  const calls = [];
  const handlers = {
    put: async () => ({ data: {} }),
    get: async (url) => {
      if (url.includes('fulfillment_policy')) {
        return { data: { fulfillmentPolicies: [{ fulfillmentPolicyId: 'fp_1' }] } };
      }
      if (url.includes('payment_policy')) {
        return { data: { paymentPolicies: [{ paymentPolicyId: 'pp_1' }] } };
      }
      if (url.includes('return_policy')) {
        return { data: { returnPolicies: [{ returnPolicyId: 'rp_1' }] } };
      }
      if (url.includes('/location')) {
        return {
          data: { locations: [{ merchantLocationKey: 'loc_1', merchantLocationStatus: 'ENABLED' }] },
        };
      }
      return { data: {} };
    },
    post: async (url) => {
      if (url.includes('/offer/') && url.endsWith('/publish')) {
        return { data: { listingId: '3876543210' } };
      }
      if (url.includes('/offer')) {
        return { data: { offerId: 'offer_123' } };
      }
      return { data: {} };
    },
    ...overrides,
  };
  const http = {
    calls,
    async put(url, body, config) {
      calls.push({ method: 'PUT', url, body, config });
      return handlers.put(url, body, config);
    },
    async get(url, config) {
      calls.push({ method: 'GET', url, config });
      return handlers.get(url, config);
    },
    async post(url, body, config) {
      calls.push({ method: 'POST', url, body, config });
      return handlers.post(url, body, config);
    },
  };
  return http;
}

const AUTH_CTX = (http) => ({
  ebayAuth: { token: 'tok_test', apiBase: API_BASE },
  http,
});

test('condition mapping matches eBay inventory enum', () => {
  assert.equal(mapEbayCondition('new'), 'NEW');
  assert.equal(mapEbayCondition('like_new'), 'USED_EXCELLENT');
  assert.equal(mapEbayCondition('used_good'), 'USED_GOOD');
  assert.equal(mapEbayCondition('fair'), 'USED_ACCEPTABLE');
  assert.equal(mapEbayCondition('unknown'), 'USED_GOOD');
});

test('category inference maps jackets to clothing', () => {
  assert.equal(inferEbayCategoryId(SAMPLE_IDENTITY), '11450');
  assert.equal(inferEbayCategoryId({ ebayCategoryId: '63861' }), '63861');
  assert.equal(inferEbayCategoryId({ name: 'Fender Stratocaster guitar' }), '619');
  assert.equal(inferEbayCategoryId({}), '1');
});

test('title is eBay keyword style and within 80 chars', () => {
  const title = buildEbayTitle(SAMPLE_IDENTITY);
  assert.equal(title, 'Kith Corduroy Sherpa Jacket FW2022 XL Brown');
  assert.ok(title.length <= 80);
});

test('description includes the confirmed attributes', () => {
  const description = buildEbayDescription(SAMPLE_IDENTITY);
  assert.match(description, /Brand: Kith/);
  assert.match(description, /Size: XL/);
  assert.match(description, /Season: FW2022/);
  assert.match(description, /Like new/);
});

test('distribute builds the listing payload and publishes (happy path)', async () => {
  const http = mockHttp();
  const result = await distribute(
    {
      identity: SAMPLE_IDENTITY,
      price: 238,
      photoUrls: ['https://cdn.example.com/kith1.jpg', 'https://cdn.example.com/kith2.jpg'],
    },
    AUTH_CTX(http)
  );

  assert.equal(result.ok, true);
  assert.equal(result.marketplace, 'ebay');
  assert.equal(result.status, 'listed');
  assert.equal(result.externalId, '3876543210');
  assert.equal(result.url, 'https://www.ebay.com/itm/3876543210');

  const inventoryCall = http.calls.find((c) => c.method === 'PUT');
  assert.ok(inventoryCall.url.includes('/sell/inventory/v1/inventory_item/xl_auto_'));
  assert.equal(inventoryCall.body.condition, 'USED_EXCELLENT');
  assert.equal(inventoryCall.body.product.title, 'Kith Corduroy Sherpa Jacket FW2022 XL Brown');
  assert.deepEqual(inventoryCall.body.product.imageUrls, [
    'https://cdn.example.com/kith1.jpg',
    'https://cdn.example.com/kith2.jpg',
  ]);
  assert.equal(
    inventoryCall.config.headers.Authorization,
    'Bearer tok_test'
  );

  const offerCall = http.calls.find((c) => c.method === 'POST' && c.url.endsWith('/offer'));
  assert.equal(offerCall.body.categoryId, '11450');
  assert.equal(offerCall.body.marketplaceId, 'EBAY_US');
  assert.equal(offerCall.body.format, 'FIXED_PRICE');
  assert.deepEqual(offerCall.body.pricingSummary.price, { value: '238.00', currency: 'USD' });
  assert.equal(offerCall.body.listingPolicies.fulfillmentPolicyId, 'fp_1');
  assert.equal(offerCall.body.merchantLocationKey, 'loc_1');

  const publishCall = http.calls.find((c) => c.url.endsWith('/publish'));
  assert.ok(publishCall.url.includes('/offer/offer_123/publish'));
});

test('distribute maps /uploads paths to absolute URLs via baseUrl', async () => {
  const http = mockHttp();
  const result = await distribute(
    { identity: SAMPLE_IDENTITY, price: 238, photoPaths: ['/uploads/u1/kith.jpg'] },
    { ...AUTH_CTX(http), baseUrl: 'https://app.example.com' }
  );
  assert.equal(result.ok, true);
  const inventoryCall = http.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(inventoryCall.body.product.imageUrls, [
    'https://app.example.com/uploads/u1/kith.jpg',
  ]);
});

test('distribute returns {ok:false} when eBay is not connected', async () => {
  const http = mockHttp();
  const result = await distribute(
    {
      identity: SAMPLE_IDENTITY,
      price: 238,
      photoUrls: ['https://cdn.example.com/kith1.jpg'],
    },
    { http }
  );
  assert.equal(result.ok, false);
  assert.equal(result.marketplace, 'ebay');
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'auth');
  assert.match(result.error, /not connected/i);
  assert.equal(result.failure.platform, 'ebay');
  assert.equal(result.failure.outcome, 'error');
  assert.equal(http.calls.length, 0);
});

test('distribute returns {ok:false} when account policies are missing', async () => {
  const http = mockHttp({
    get: async () => ({ data: {} }),
  });
  const result = await distribute(
    {
      identity: SAMPLE_IDENTITY,
      price: 238,
      photoUrls: ['https://cdn.example.com/kith1.jpg'],
    },
    AUTH_CTX(http)
  );
  assert.equal(result.ok, false);
  assert.equal(result.step, 'policies');
  assert.match(result.error, /Seller Hub/);
  assert.equal(result.code, 'ebay_policies_required');
  assert.ok(http.calls.every((c) => !c.url.endsWith('/publish')));
});

test('distribute returns {ok:false} when publish fails', async () => {
  const apiError = new Error('Request failed with status code 400');
  apiError.response = {
    status: 400,
    data: { errors: [{ message: 'Invalid category for this marketplace' }] },
  };
  const http = mockHttp({
    post: async (url) => {
      if (url.endsWith('/publish')) throw apiError;
      if (url.includes('/offer')) return { data: { offerId: 'offer_123' } };
      return { data: {} };
    },
  });
  const result = await distribute(
    {
      identity: SAMPLE_IDENTITY,
      price: 238,
      photoUrls: ['https://cdn.example.com/kith1.jpg'],
    },
    AUTH_CTX(http)
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Invalid category for this marketplace');
  assert.equal(result.statusCode, 400);
  assert.ok(Array.isArray(result.failure.trace));
  assert.ok(result.failure.trace.length > 0);
});

test('distribute rejects an invalid price without calling eBay', async () => {
  const http = mockHttp();
  const result = await distribute(
    {
      identity: SAMPLE_IDENTITY,
      price: 0,
      photoUrls: ['https://cdn.example.com/kith1.jpg'],
    },
    AUTH_CTX(http)
  );
  assert.equal(result.ok, false);
  assert.equal(result.step, 'validate');
  assert.equal(http.calls.length, 0);
});

test('distribute rejects unresolvable local photo paths', async () => {
  const http = mockHttp();
  const result = await distribute(
    { identity: SAMPLE_IDENTITY, price: 238, photoPaths: ['/tmp/kith.jpg'] },
    AUTH_CTX(http)
  );
  assert.equal(result.ok, false);
  assert.equal(result.step, 'photos');
  assert.equal(http.calls.length, 0);
});

test('distribute accepts a plain token string and a getToken getter', async () => {
  for (const ebayAuth of ['tok_plain', { getToken: async () => 'tok_getter' }]) {
    const http = mockHttp();
    const result = await distribute(
      {
        identity: SAMPLE_IDENTITY,
        price: 238,
        photoUrls: ['https://cdn.example.com/kith1.jpg'],
      },
      { ebayAuth, http, apiBase: API_BASE }
    );
    assert.equal(result.ok, true);
    const call = http.calls.find((c) => c.method === 'PUT');
    assert.match(call.config.headers.Authorization, /^Bearer tok_(plain|getter)$/);
  }
});
