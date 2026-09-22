import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  describeFetchFailure,
  ebayListingFormUrl,
  requestJson,
  resolveEbayListingPage,
} from '../extension/create-listings.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.chrome;
});

function mockEbaySession() {
  globalThis.chrome = {
    cookies: {
      getAll: async () => [{ name: 's', value: 'session' }],
      get: async () => null,
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('describeFetchFailure names eBay as the source of Failed to fetch', () => {
  const described = describeFetchFailure(new TypeError('Failed to fetch'), {
    url: 'https://www.ebay.com/sl/prelist/api/suggest?keyword=Patagonia',
    method: 'GET',
    step: 'finding an eBay category',
  });
  assert.equal(described.detail.source, 'ebay');
  assert.match(described.message, /eBay/);
  assert.match(described.message, /finding an eBay category/);
  assert.match(described.message, /GET \/sl\/prelist\/api\/suggest/);
  assert.doesNotMatch(described.message, /^Failed to fetch$/);
});

test('describeFetchFailure names Crosslist when the dashboard API is unreachable', () => {
  const described = describeFetchFailure(new TypeError('Failed to fetch'), {
    url: 'http://localhost:3000/api/listings/item_1/push',
    method: 'POST',
    step: 'apiFetch',
  });
  assert.equal(described.detail.source, 'crosslist');
  assert.match(described.message, /Crosslist/);
  assert.match(described.message, /\/api\/listings\/item_1\/push/);
});

test('requestJson wraps Failed to fetch with the failing eBay URL', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    () =>
      requestJson('https://www.ebay.com/sl/prelist/api/suggest?keyword=Patagonia', {
        method: 'GET',
        step: 'finding an eBay category',
      }),
    (error) => {
      assert.equal(error.detail.source, 'ebay');
      assert.equal(error.detail.path, '/sl/prelist/api/suggest');
      assert.match(error.message, /eBay/);
      assert.doesNotMatch(error.message, /^Failed to fetch$/);
      return true;
    }
  );
});

test('resolveEbayListingPage returns a sourced error instead of throwing Failed to fetch', async () => {
  mockEbaySession();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    throw new TypeError('Failed to fetch');
  };
  const notes = [];
  const result = await resolveEbayListingPage(
    { title: 'Patagonia fleece', price: 48, quantity: 1 },
    { note: (message, extra) => notes.push({ message, extra }) }
  );
  assert.equal(result.url, undefined);
  assert.match(result.error, /eBay/);
  assert.match(result.error, /checking the eBay session/);
  assert.doesNotMatch(result.error, /^Failed to fetch$/);
  assert.ok(urls.some((url) => url.includes('/sh/lst/active')));
  assert.ok(urls.every((url) => !/\/lstng\/api/.test(url)));
  assert.ok(notes.some((note) => /eBay/i.test(note.message)));
});

test('resolveEbayListingPage opens the current listing form instead of dead draft APIs', async () => {
  mockEbaySession();
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ method: options.method || 'GET', href });
    if ((options.method || 'GET') === 'GET' && href.includes('/sh/lst/active')) {
      return new Response('<html><body>Seller Hub</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (href.includes('/sl/prelist/api/suggest')) {
      return jsonResponse(200, {
        modules: { KEYWORDMETADATA: { categoryId: '57988', categoryConfidence: 'HIGH' } },
      });
    }
    throw new TypeError(`Unexpected fetch ${options.method || 'GET'} ${href}`);
  };
  const result = await resolveEbayListingPage({ title: 'Patagonia fleece', price: 48, quantity: 1 });
  assert.equal(result.error, undefined);
  assert.match(result.url, /^https:\/\/www\.ebay\.com\/sl\/list\?/);
  assert.match(result.url, /mode=AddItem/);
  assert.match(result.url, /title=Patagonia(\+|%20)fleece/);
  assert.match(result.url, /categoryId=57988/);
  assert.equal(result.categoryId, '57988');
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  assert.equal(calls.some((call) => /\/lstng\/api|\/sl\/list\/api\/draft/.test(call.href)), false);
});

test('resolveEbayListingPage falls back to list-an-item when category suggest misses', async () => {
  mockEbaySession();
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if ((options.method || 'GET') === 'GET' && href.includes('/sh/lst/active')) {
      return new Response('<html><body>Seller Hub</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/html' } });
  };
  const result = await resolveEbayListingPage({ title: 'Patagonia fleece', price: 48, quantity: 1 });
  assert.equal(result.error, undefined);
  assert.equal(result.url, 'https://www.ebay.com/sl/prelist/suggest');
});

test('ebayListingFormUrl matches eBay’s current list flow', () => {
  const url = ebayListingFormUrl('Patagonia fleece', '57988');
  assert.equal(
    url,
    'https://www.ebay.com/sl/list?mode=AddItem&title=Patagonia+fleece&categoryId=57988&sr=sug'
  );
});

test('probe eBay listing hosts to record reachability', async () => {
  const targets = [
    { method: 'GET', url: 'https://www.ebay.com/sh/lst/active?sort=-timeRemaining' },
    { method: 'GET', url: 'https://www.ebay.com/sl/prelist/api/suggest?keyword=Patagonia%20fleece' },
    { method: 'GET', url: 'https://api.ebay.com/sell/inventory/v1/inventory_item' },
  ];
  const findings = [];
  for (const target of targets) {
    try {
      const response = await fetch(target.url, {
        method: target.method,
        headers: { Accept: 'application/json, text/html;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      findings.push({
        ...target,
        kind: 'http',
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get('content-type'),
      });
    } catch (error) {
      findings.push({
        ...target,
        kind: 'throw',
        name: error.name,
        message: error.message,
        cause: error.cause?.message || error.cause?.code,
      });
    }
  }
  console.log('eBay listing probe', JSON.stringify(findings, null, 2));
  assert.equal(findings.length, targets.length);
  const sellerHub = findings[0];
  if (sellerHub.kind === 'http') {
    assert.ok(sellerHub.status > 0, 'www.ebay.com seller hub returned an HTTP status');
  } else {
    assert.ok(sellerHub.message, 'www.ebay.com seller hub failed with a named network error');
  }
  const suggest = findings[1];
  if (suggest.kind === 'http') {
    assert.ok(suggest.status > 0, 'eBay prelist suggest returned an HTTP status');
  }
});
