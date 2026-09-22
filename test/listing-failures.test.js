import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { compactListingFailure } from '../extension/listing-failure.js';
import { sanitizeListingFailure, safeFailureId } from '../server/listing-failures.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'crosslist-failures-'));
process.env.DATA_DIR = dataDir;
const userStore = await import('../server/db.js');

test('compactListingFailure keeps the failed step and drops secrets', () => {
  const failure = compactListingFailure(
    { id: 'item_1', title: 'Vintage amp' },
    'ebay',
    {
      error: 'Could not reach eBay while finding an eBay category',
      detail: {
        source: 'ebay',
        step: 'finding an eBay category',
        status: 0,
        cookie: 'session-secret',
        url: 'https://www.ebay.com/sl/prelist/api/suggest?keyword=Patagonia&token=abc',
        code: '25001',
      },
    },
    [
      {
        at: '2026-09-21T00:00:00.000Z',
        message: 'Opening eBay list-an-item so you can finish the listing',
        extra: {
          authorization: 'Bearer secret',
          attempts: [{ path: '/sl/prelist/api/suggest', status: 0, error: 'Failed to fetch' }],
        },
      },
    ]
  );

  assert.equal(failure.platform, 'ebay');
  assert.equal(failure.outcome, 'error');
  assert.equal(failure.listingId, 'item_1');
  assert.equal(failure.step, 'finding an eBay category');
  assert.equal(failure.status, 0);
  assert.equal(failure.marketplaceCode, '25001');
  assert.equal(safeFailureId(failure.id), failure.id);
  assert.equal(failure.trace.length, 1);
  assert.equal(failure.trace[0].extra.authorization, '[redacted]');
  assert.equal(failure.trace[0].extra.attempts[0].path, '/sl/prelist/api/suggest');
  assert.equal(failure.detail, undefined);
});

test('sanitizeListingFailure strips query strings and refuses an unsafe id', () => {
  const clean = sanitizeListingFailure({
    id: '11111111-2222-4333-8444-555555555555',
    platform: 'Ebay',
    title: 'Vintage amp',
    error: 'Could not reach eBay',
    step: 'finding an eBay category',
    status: 401,
    source: 'ebay',
    marketplaceCode: '25001',
    trace: [
      {
        at: '2026-09-21T00:00:00.000Z',
        message: 'category suggest failed',
        extra: {
          url: 'https://www.ebay.com/sl/prelist/api/suggest?keyword=Patagonia&token=abc&refresh=1',
          cookie: 'nonsession=secret',
          attempts: [{ path: '/sl/prelist/api/suggest', status: 401, error: 'auth' }],
        },
      },
    ],
  });

  assert.equal(clean.platform, 'ebay');
  assert.equal(clean.marketplaceCode, '25001');
  assert.equal(clean.trace[0].extra.url, 'https://www.ebay.com/sl/prelist/api/suggest');
  assert.equal(clean.trace[0].extra.cookie, '[redacted]');
  assert.equal(clean.trace[0].extra.attempts[0].status, 401);
  assert.equal(sanitizeListingFailure({ error: 'no platform' }), null);
  assert.equal(safeFailureId('token=abc'), null);
});

test('listing failure records are stored once per failure id', () => {
  const userId = 'user_failure_test';
  const now = new Date().toISOString();
  userStore.db.prepare(`
    INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, 'failure-test@example.com', 'hash', 'Test', now, now);

  const failureId = '11111111-2222-4333-8444-555555555555';
  const detail = { failureId, platform: 'ebay', error: 'Could not reach eBay', trace: [] };
  assert.equal(userStore.hasListingFailure(userId, failureId), false);
  userStore.appendActivity(userId, {
    type: 'error',
    source: 'extension',
    message: 'eBay listing failed for "Vintage amp"',
    detail,
  });
  assert.equal(userStore.hasListingFailure(userId, failureId), true);
  assert.equal(userStore.hasListingFailure(userId, 'not-a-real-id'), false);
});

after(() => {
  userStore.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
