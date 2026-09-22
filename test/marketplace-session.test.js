import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ebaySessionOk,
  listOnReverb,
  resolveEbayListingPage,
  reverbSessionOk,
} from '../extension/create-listings.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.chrome;
});

function mockCookies(cookiesByDomain) {
  globalThis.chrome = {
    cookies: {
      getAll: async ({ domain } = {}) => cookiesByDomain[domain] || [],
      get: async ({ url, name } = {}) => {
        const host = url ? new URL(url).hostname.replace(/^www\./, '') : '';
        return (cookiesByDomain[host] || []).find((cookie) => cookie.name === name) || null;
      },
    },
  };
}

function jsonResponse(status, body, url) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
    url,
  });
}

test('ebaySessionOk ignores the anonymous nonsession cookie', async () => {
  mockCookies({
    'ebay.com': [{ name: 'nonsession', value: 'anon' }],
    'ebay.co.uk': [{ name: 'nonsession', value: 'anon' }],
  });
  assert.equal(await ebaySessionOk(), false);
});

test('ebaySessionOk requires the s session cookie', async () => {
  mockCookies({
    'ebay.com': [{ name: 's', value: 'logged-in' }],
    'ebay.co.uk': [{ name: 'nonsession', value: 'anon' }],
  });
  assert.equal(await ebaySessionOk(), true);
});

test('resolveEbayListingPage does not hit eBay when only the nonsession cookie is present', async () => {
  mockCookies({
    'ebay.com': [{ name: 'nonsession', value: 'anon' }],
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    throw new Error('should not fetch');
  };
  const result = await resolveEbayListingPage({ title: 'Patagonia fleece', price: 48, quantity: 1 });
  assert.equal(result.url, undefined);
  assert.match(result.error, /Reconnect eBay/);
  assert.deepEqual(urls, []);
});

test('reverbSessionOk is false when there are no reverb.com cookies', async () => {
  mockCookies({});
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    throw new Error('should not fetch');
  };
  assert.equal(await reverbSessionOk(), false);
  assert.deepEqual(urls, []);
});

test('listOnReverb fails closed when identity probes return 401', async () => {
  mockCookies({
    'reverb.com': [{ name: 'visitor', value: 'anon' }],
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href === 'https://reverb.com/') {
      return new Response('<html><meta name="csrf-token" content="token"></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return jsonResponse(401, { message: 'unauthorized' }, href);
  };
  const result = await listOnReverb({ title: 'Fender Stratocaster', price: 480, quantity: 1 });
  assert.equal(result.success, false);
  assert.match(result.error, /Reconnect Reverb/);
  assert.ok(urls.some((url) => url.includes('/api/my')));
  assert.ok(urls.every((url) => !url.includes('/api/listings')));
});
