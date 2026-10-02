import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distribute,
  getJob,
  normalizeGrailedPhotos,
  mapGrailedCondition,
  __setJobStore,
} from '../server/grailed-distribute.js';

// In-memory store so tests never touch the real sqlite file.
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
  };
}

const identity = (overrides = {}) => ({
  title: 'Kith x New York Knicks Satin Bomber',
  description: 'Worn twice, no flaws. From the 2024 collaboration.',
  condition: 'like_new',
  details: { designer: 'Kith', size: 'L', color: 'Blue / Orange' },
  ...overrides,
});

test('pending: extension available queues a job and persists it', async () => {
  const store = mockStore();
  __setJobStore(store);

  const result = await distribute(
    {
      identity: identity(),
      price: 238,
      photoPaths: [],
      photoUrls: ['https://example.com/photo1.jpg', 'data:image/jpeg;base64,AAAA'],
    },
    { userId: 'user_1', extensionAvailable: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.marketplace, 'grailed');
  assert.equal(result.status, 'pending');
  assert.ok(result.jobId, 'jobId should be present');

  const saved = getJob(result.jobId);
  assert.ok(saved, 'job should be retrievable');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.title, 'Kith x New York Knicks Satin Bomber');
  assert.equal(saved.price, 238);
  assert.equal(saved.payload.condition, 'like new');
  assert.deepEqual(saved.payload.images, [
    'https://example.com/photo1.jpg',
    'data:image/jpeg;base64,AAAA',
  ]);
  assert.equal(saved.payload.details.designer, 'Kith');
});

test('guided: unknown/absent extension returns an honest manual checklist', async () => {
  __setJobStore(mockStore());

  for (const ctx of [{}, { extensionAvailable: false }, { extensionAvailable: undefined }]) {
    const result = await distribute(
      { identity: identity(), price: 238, photoPaths: [], photoUrls: [] },
      ctx
    );
    assert.equal(result.ok, true);
    assert.equal(result.marketplace, 'grailed');
    assert.equal(result.status, 'guided');
    assert.ok(!result.jobId, 'guided must not invent a jobId');
    assert.ok(result.guide.url.includes('grailed.com/sell/new'));
    assert.ok(result.guide.steps.length >= 5, 'checklist should be complete');
    assert.ok(
      result.guide.steps.some((step) => /publish yourself/i.test(step)),
      'checklist must say the user publishes'
    );
    assert.ok(
      result.guide.steps.some((step) => /Kith x New York Knicks/.test(step)),
      'checklist must be prefilled with the item title'
    );
  }
});

test('failed: missing title or price never queues anything', async () => {
  const store = mockStore();
  __setJobStore(store);

  const noTitle = await distribute(
    { identity: identity({ title: '' }), price: 100, photoPaths: [], photoUrls: [] },
    { extensionAvailable: true }
  );
  assert.equal(noTitle.status, 'failed');
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.error, /title/i);

  const noPrice = await distribute(
    { identity: identity(), price: 0, photoPaths: [], photoUrls: [] },
    { extensionAvailable: true }
  );
  assert.equal(noPrice.status, 'failed');
  assert.equal(noPrice.ok, false);
  assert.match(noPrice.error, /price/i);

  assert.equal(store.rows.size, 0, 'no jobs should be persisted on failure');
});

test('photo normalization keeps only data: and https: URLs', () => {
  const out = normalizeGrailedPhotos(
    ['/local/path/photo.jpg', 'data:image/jpeg;base64,AAAA', 'ftp://x/photo.jpg'],
    ['https://example.com/a.jpg', 'http://example.com/b.jpg', '']
  );
  assert.deepEqual(out, ['https://example.com/a.jpg', 'data:image/jpeg;base64,AAAA']);
});

test('condition mapping prefers closest Grailed label', () => {
  assert.equal(mapGrailedCondition('new'), 'new');
  assert.equal(mapGrailedCondition('brand_new'), 'new');
  assert.equal(mapGrailedCondition('like_new'), 'like new');
  assert.equal(mapGrailedCondition('mint'), 'like new');
  assert.equal(mapGrailedCondition('used_excellent'), 'gently used');
  assert.equal(mapGrailedCondition('used_good'), 'used');
  assert.equal(mapGrailedCondition('poor'), 'very worn');
  assert.equal(mapGrailedCondition('something weird'), 'used');
  assert.equal(mapGrailedCondition(null), 'used');
});

test('price accepts identity fallback and string input', async () => {
  __setJobStore(mockStore());
  const result = await distribute(
    { identity: identity({ price: '199.99' }), photoPaths: [], photoUrls: [] },
    { extensionAvailable: true }
  );
  assert.equal(result.status, 'pending');
  assert.equal(getJob(result.jobId).price, 199.99);
});
