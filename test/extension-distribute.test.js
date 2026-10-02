// test/extension-distribute.test.js
//
// Covers the extension-only distribution core (server/extension-distribute.js)
// and the thin per-store distributors: validation, job persistence, the
// extensionTask handed to the browser page, and per-store condition maps.
// No network or credentials: the job store is swapped for an in-memory one.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const core = await import('../server/extension-distribute.js');

function mockStore() {
  const rows = new Map();
  return {
    rows,
    insert(job) {
      rows.set(job.id, { ...job });
      return job.id;
    },
    get(id) {
      return rows.get(String(id)) || null;
    },
    updateStatus(id, status) {
      const row = rows.get(String(id));
      if (row) row.status = status;
      return row || null;
    },
  };
}

let store;
beforeEach(() => {
  store = mockStore();
  core.__setJobStore(store);
});

const identity = (overrides = {}) => ({
  title: 'Kith Corduroy Sherpa Trucker Jacket',
  description: 'FW22, worn a handful of times.',
  condition: 'like_new',
  category: 'clothing',
  details: { designer: 'Kith', size: 'XL' },
  ...overrides,
});

const ctx = { userId: 'user_1', dashboardOrigin: 'http://localhost:3000' };

test('every store queues a pending job with an extensionTask for the page', async () => {
  for (const marketplace of ['ebay', 'depop', 'poshmark', 'etsy', 'reverb']) {
    const mod = await import(`../server/${marketplace}-distribute.js`);
    const result = await mod.distribute(
      {
        identity: identity(),
        price: 350,
        photoPaths: [],
        photoUrls: ['/uploads/user_1/a.jpg', 'https://cdn.example.com/b.jpg'],
      },
      ctx
    );
    assert.equal(result.ok, true, marketplace);
    assert.equal(result.marketplace, marketplace);
    assert.equal(result.status, 'pending');
    assert.ok(result.jobId, `${marketplace} jobId`);
    assert.equal(result.extensionTask.platform, marketplace);
    assert.equal(result.extensionTask.dashboardOrigin, 'http://localhost:3000');
    assert.equal(result.extensionTask.listing.title, 'Kith Corduroy Sherpa Trucker Jacket');
    assert.equal(result.extensionTask.listing.price, 350);
    // Relative photo URLs are absolutized against the dashboard origin so the
    // extension can fetch them; absolute URLs pass through untouched.
    assert.deepEqual(result.extensionTask.listing.images, [
      'http://localhost:3000/uploads/user_1/a.jpg',
      'https://cdn.example.com/b.jpg',
    ]);
    // The job row is persisted for the audit trail.
    const job = core.getExtensionJob(result.jobId);
    assert.equal(job.marketplace, marketplace);
    assert.equal(job.status, 'pending');
    assert.equal(job.title, 'Kith Corduroy Sherpa Trucker Jacket');
  }
});

test('distribute fails cleanly on missing title or bad price', async () => {
  const mod = await import('../server/ebay-distribute.js');
  const noTitle = await mod.distribute({ identity: identity({ title: '  ' }), price: 10, photoUrls: [] }, ctx);
  assert.equal(noTitle.ok, false);
  assert.equal(noTitle.status, 'failed');
  assert.match(noTitle.error, /title/i);
  assert.equal(store.rows.size, 0, 'no job row for invalid input');

  const badPrice = await mod.distribute({ identity: identity(), price: -5, photoUrls: [] }, ctx);
  assert.equal(badPrice.status, 'failed');
  assert.match(badPrice.error, /price/i);
});

test('photo list is capped per store', async () => {
  const { distribute } = await import('../server/depop-distribute.js'); // limit 10
  const urls = Array.from({ length: 25 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  const result = await distribute({ identity: identity(), price: 50, photoUrls: urls }, ctx);
  assert.equal(result.extensionTask.listing.images.length, 10);
});

test('condition maps match each store vocabulary', () => {
  assert.equal(core.mapEbayCondition('new'), 'NEW');
  assert.equal(core.mapEbayCondition('like_new'), 'USED_EXCELLENT');
  assert.equal(core.mapEbayCondition('used_fair'), 'USED_ACCEPTABLE');
  assert.equal(core.mapEbayCondition('bogus'), 'USED_GOOD');
  assert.equal(core.mapDepopCondition('new'), 'new_with_tags');
  assert.equal(core.mapDepopCondition('like_new'), 'new_without_tags');
  assert.equal(core.mapDepopCondition('poor'), 'used_fair');
  assert.equal(core.mapDepopCondition('bogus'), 'used_good');
});

test('markExtensionJob updates the queued job status', async () => {
  const { distribute } = await import('../server/poshmark-distribute.js');
  const result = await distribute({ identity: identity(), price: 75, photoUrls: [] }, ctx);
  const updated = core.markExtensionJob(result.jobId, 'listed');
  assert.equal(updated.status, 'listed');
  assert.equal(core.getExtensionJob(result.jobId).status, 'listed');
});

test('createExtensionDistributor rejects unknown marketplaces', () => {
  assert.throws(() => core.createExtensionDistributor('facebook'), /No extension distribution config/);
});
