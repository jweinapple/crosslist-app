// test/auto-distribute.test.js
//
// Covers the photos-only auto-list pipeline in server/auto-distribute.js:
//   startAutoList -> photo-intel identify + price suggestion, job persisted
//   confirmAutoList -> uniform distributor interface, per-marketplace status,
//                      graceful missing-module handling, failure recording
//   getAutoListStatus -> per-marketplace status read-back
//
// photo-intel and the three distributors are injected through
// __setAutoListTestModules so no real credentials or network are involved.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'crosslist-autolist-'));
process.env.DATA_DIR = dataDir;

const autoList = await import('../server/auto-distribute.js');
const userStore = await import('../server/db.js');

const OWNER = 'owner1';
const PHOTO_URL = `/uploads/${OWNER}/photo1.jpg`;

function seedPhoto(name = 'photo1.jpg') {
  const dir = path.join(dataDir, 'uploads', OWNER);
  mkdirSync(dir, { recursive: true });
  // Minimal valid-ish JPEG bytes; resolveAutoListPhotos only checks existence/size.
  writeFileSync(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01]));
  return `/uploads/${OWNER}/${name}`;
}

const fakeIntel = {
  identifyProduct: async (photoPaths) => {
    assert.ok(Array.isArray(photoPaths) && photoPaths.length > 0, 'identifyProduct gets photo paths');
    return {
      brand: 'Fender',
      model: 'Vintera',
      name: "Vintera '50s Stratocaster",
      size: '',
      color: 'Surf Green',
      condition: 'Used — Good',
      confidence: 0.93,
    };
  },
  suggestPrice: async (identity) => {
    assert.equal(identity.brand, 'Fender');
    return {
      price: 655,
      currency: 'USD',
      comps: [
        { title: 'Fender Vintera 50s Strat Surf Green', price: 640, soldDate: '2026-09-20', source: 'eBay sold' },
        { title: 'Fender Vintera Road Worn 50s Strat', price: 669, soldDate: '2026-09-18', source: 'eBay sold' },
      ],
      rationale: 'Based on 2 recent sold listings in Surf Green.',
    };
  },
};

const seenPayloads = {};
function okDistributor(marketplace, extra = {}) {
  return async (payload, ctx) => {
    seenPayloads[marketplace] = { payload, ctxUserId: ctx?.user?.id };
    return { ok: true, marketplace, status: 'listed', externalId: `ext-${marketplace}`, url: `https://example.com/${marketplace}/1`, ...extra };
  };
}

function ctxFor(userId = 'user_1') {
  return { user: { id: userId }, baseUrl: 'http://localhost:3000' };
}

// activity_logs.user_id has a FK to users(id): failure recording needs real
// user rows, so ensure them for every test user id.
function ensureUser(userId) {
  const now = new Date().toISOString();
  userStore.db
    .prepare(
      'INSERT OR IGNORE INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, `${userId}@test.local`, 'test', now, now);
}

async function catchReject(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
}

function catchThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the function to throw');
}

beforeEach(() => {
  autoList.__clearAutoListTestModules();
  autoList.__setAutoListTestModules({
    photoIntel: fakeIntel,
    distributors: {
      ebay: okDistributor('ebay'),
      facebook: okDistributor('facebook'),
      grailed: okDistributor('grailed'),
    },
  });
  for (const key of Object.keys(seenPayloads)) delete seenPayloads[key];
  for (const userId of ['user_1', 'owner_a', 'owner_b', 'user_nr']) ensureUser(userId);
});

after(() => {
  autoList.__clearAutoListTestModules();
});

test('startAutoList identifies the product, suggests a price, and persists the job', async () => {
  const photo = seedPhoto();
  const result = await autoList.startAutoList([photo], ctxFor());

  assert.ok(result.jobId.startsWith('auto_'));
  assert.equal(result.identity.brand, 'Fender');
  assert.equal(result.identity.color, 'Surf Green');
  assert.equal(result.confidence, 0.93);
  assert.equal(result.price, 655);
  assert.equal(result.currency, 'USD');
  assert.equal(result.comps.length, 2);
  assert.match(result.rationale, /sold listings/);

  const status = autoList.getAutoListStatus(result.jobId, ctxFor());
  assert.equal(status.stage, 'awaiting_confirmation');
  assert.equal(status.price, 655);
  assert.deepEqual(status.photos, ['http://localhost:3000' + photo]);
});

test('startAutoList rejects empty and missing photos', async () => {
  await assert.rejects(autoList.startAutoList([], ctxFor()), /at least one photo/i);
  await assert.rejects(autoList.startAutoList([`/uploads/${OWNER}/nope.jpg`], ctxFor()), /not found/i);
});

test('startAutoList fails cleanly when photo-intel is missing', async () => {
  autoList.__clearAutoListTestModules();
  // Simulate the module being absent via Error injection (server/photo-intel.js
  // exists on disk by design; this exercises the same graceful path).
  autoList.__setAutoListTestModules({
    photoIntel: new Error(
      'Photo identification is not available yet (server/photo-intel.js could not be loaded): simulated missing module'
    ),
  });
  const photo = seedPhoto();
  const error = await catchReject(autoList.startAutoList([photo], ctxFor()));
  assert.equal(error.status, 503);
  assert.match(error.message, /not available/i);
  assert.ok(error.jobId);
  const status = autoList.getAutoListStatus(error.jobId, ctxFor());
  assert.equal(status.stage, 'failed');
});

test('startAutoList marks the job failed when photo-intel throws', async () => {
  autoList.__setAutoListTestModules({
    photoIntel: {
      identifyProduct: async () => { throw new Error('vision service exploded'); },
      suggestPrice: async () => ({}),
    },
  });
  const photo = seedPhoto();
  const error = await catchReject(autoList.startAutoList([photo], ctxFor()));
  assert.match(error.message, /vision service exploded/);
  const status = autoList.getAutoListStatus(error.jobId, ctxFor());
  assert.equal(status.stage, 'failed');
});

test('confirmAutoList distributes to all three marketplaces with the uniform payload', async () => {
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());

  const result = await autoList.confirmAutoList(jobId, {}, ctxFor());
  assert.equal(result.jobId, jobId);
  assert.equal(result.statuses.length, 3);
  for (const s of result.statuses) {
    assert.equal(s.status, 'listed');
    assert.ok(s.externalId);
    assert.ok(s.url);
  }
  assert.deepEqual(result.statuses.map((s) => s.marketplace), ['ebay', 'facebook', 'grailed']);

  // Uniform distributor payload shape.
  for (const marketplace of ['ebay', 'facebook', 'grailed']) {
    const { payload, ctxUserId } = seenPayloads[marketplace];
    assert.equal(ctxUserId, 'user_1');
    assert.equal(payload.identity.brand, 'Fender');
    assert.equal(payload.price, 655);
    assert.ok(Array.isArray(payload.photoPaths) && payload.photoPaths.length === 1);
    assert.ok(payload.photoPaths[0].endsWith('photo1.jpg'));
    assert.ok(Array.isArray(payload.photoUrls) && payload.photoUrls[0].startsWith('http://localhost:3000/uploads/'));
  }

  const status = autoList.getAutoListStatus(jobId, ctxFor());
  assert.equal(status.stage, 'done');
  assert.equal(status.statuses.find((s) => s.marketplace === 'ebay').status, 'listed');
});

test('confirmAutoList applies user corrections to identity and price', async () => {
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());

  const corrected = { brand: 'Fender', name: 'Player Stratocaster', color: 'Tidepool', condition: 'Used — Excellent', size: '', model: '' };
  const result = await autoList.confirmAutoList(jobId, { identity: corrected, price: 700 }, ctxFor());
  assert.ok(result.statuses.every((s) => s.status === 'listed'));
  assert.equal(seenPayloads.ebay.payload.identity.name, 'Player Stratocaster');
  assert.equal(seenPayloads.ebay.payload.price, 700);

  const status = autoList.getAutoListStatus(jobId, ctxFor());
  assert.equal(status.identity.name, 'Player Stratocaster');
  assert.equal(status.price, 700);
});

test('confirmAutoList marks a missing distributor module as failed without crashing', async () => {
  // Simulate the grailed distributor module being absent via Error injection
  // (server/grailed-distribute.js exists on disk by design; this exercises
  // the same graceful "module not available" path as a failed import).
  autoList.__setAutoListTestModules({
    distributors: {
      ebay: okDistributor('ebay'),
      facebook: okDistributor('facebook'),
      grailed: new Error(
        'The Grailed distributor (server/grailed-distribute.js) is not available yet: simulated missing module'
      ),
    },
  });
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());

  const result = await autoList.confirmAutoList(jobId, {}, ctxFor());
  const grailed = result.statuses.find((s) => s.marketplace === 'grailed');
  assert.equal(grailed.status, 'failed');
  assert.match(grailed.error, /grailed-distribute\.js/i);
  assert.match(grailed.error, /not available/i);

  const ebay = result.statuses.find((s) => s.marketplace === 'ebay');
  assert.equal(ebay.status, 'listed');

  // Failure recorded through the listing-failures system (activity log).
  const activity = userStore.listActivity('user_1', 50);
  const failureEntry = activity.find((entry) => entry.source === 'auto-list' && entry.type === 'error');
  assert.ok(failureEntry, 'expected an auto-list failure activity entry');
  assert.match(failureEntry.message, /Grailed/i);
});

test('confirmAutoList records a distributor throw as a failed marketplace', async () => {
  autoList.__setAutoListTestModules({
    distributors: {
      ebay: async () => { throw new Error('eBay OAuth token expired'); },
      facebook: okDistributor('facebook', { status: 'guided', jobId: 'fb-ext-9' }),
      grailed: okDistributor('grailed', { status: 'pending' }),
    },
  });
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());

  const result = await autoList.confirmAutoList(jobId, {}, ctxFor());
  const byMarket = Object.fromEntries(result.statuses.map((s) => [s.marketplace, s]));
  assert.equal(byMarket.ebay.status, 'failed');
  assert.match(byMarket.ebay.error, /token expired/);
  assert.equal(byMarket.facebook.status, 'guided');
  assert.equal(byMarket.facebook.jobId, 'fb-ext-9');
  assert.equal(byMarket.grailed.status, 'pending');
});

test('confirmAutoList coerces an unrecognized distributor status to failed', async () => {
  autoList.__setAutoListTestModules({
    distributors: {
      ebay: async () => ({ ok: true, marketplace: 'ebay', status: 'teleported' }),
      facebook: okDistributor('facebook'),
      grailed: okDistributor('grailed'),
    },
  });
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());
  const result = await autoList.confirmAutoList(jobId, {}, ctxFor());
  const ebay = result.statuses.find((s) => s.marketplace === 'ebay');
  assert.equal(ebay.status, 'failed');
  assert.match(ebay.error, /unrecognized status/i);
});

test('needsReview/pending/guided are first-class statuses, not failures', async () => {
  autoList.__setAutoListTestModules({
    distributors: {
      ebay: async () => ({ ok: true, marketplace: 'ebay', status: 'needsReview', externalId: 'eb-1' }),
      facebook: okDistributor('facebook', { status: 'guided', jobId: 'fb-ext-9' }),
      grailed: okDistributor('grailed', { status: 'pending' }),
    },
  });
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor('user_nr'));

  const result = await autoList.confirmAutoList(jobId, {}, ctxFor('user_nr'));
  const byMarket = Object.fromEntries(result.statuses.map((s) => [s.marketplace, s]));
  assert.equal(byMarket.ebay.status, 'needsReview');
  assert.equal(byMarket.ebay.error, null);
  assert.equal(byMarket.facebook.status, 'guided');
  assert.equal(byMarket.grailed.status, 'pending');

  // Nothing recorded through the listing-failures pipeline for these.
  const activity = userStore.listActivity('user_nr', 50);
  assert.ok(
    !activity.some((entry) => entry.source === 'auto-list' && entry.type === 'error'),
    'needsReview/pending/guided must not be recorded as failures'
  );

  const status = autoList.getAutoListStatus(jobId, ctxFor('user_nr'));
  assert.equal(status.statuses.find((s) => s.marketplace === 'ebay').status, 'needsReview');
});

test('confirmAutoList is single-shot: a second confirm is rejected', async () => {
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor());
  await autoList.confirmAutoList(jobId, {}, ctxFor());
  const error = await catchReject(autoList.confirmAutoList(jobId, {}, ctxFor()));
  assert.equal(error.status, 409);
});

test('confirmAutoList 404s unknown jobs', async () => {
  const error = await catchReject(autoList.confirmAutoList('auto_does-not-exist', {}, ctxFor()));
  assert.equal(error.status, 404);
});

test('getAutoListStatus enforces job ownership and 404s unknown jobs', async () => {
  const photo = seedPhoto();
  const { jobId } = await autoList.startAutoList([photo], ctxFor('owner_a'));
  const forbidden = catchThrow(() => autoList.getAutoListStatus(jobId, ctxFor('owner_b')));
  assert.match(forbidden.message, /another account/);
  const missing = catchThrow(() => autoList.getAutoListStatus('auto_missing', ctxFor('owner_a')));
  assert.match(missing.message, /not found/);
  const confirmForbidden = await catchReject(autoList.confirmAutoList(jobId, {}, ctxFor('owner_b')));
  assert.match(confirmForbidden.message, /another account/);
});

test('all entry points require a signed-in user', async () => {
  const photo = seedPhoto();
  const startError = await catchReject(autoList.startAutoList([photo], {}));
  assert.match(startError.message, /sign in/i);
  const confirmError = await catchReject(autoList.confirmAutoList('auto_x', {}, {}));
  assert.match(confirmError.message, /sign in/i);
  const statusError = catchThrow(() => autoList.getAutoListStatus('auto_x', {}));
  assert.match(statusError.message, /sign in/i);
});

test('resolveAutoListPhotos maps /uploads URLs to the existing uploads dir', () => {
  const photo = seedPhoto('photo2.jpg');
  const resolved = autoList.resolveAutoListPhotos([photo], 'https://shop.example.com/');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].path, path.join(dataDir, 'uploads', OWNER, 'photo2.jpg'));
  assert.equal(resolved[0].url, 'https://shop.example.com' + photo);
  assert.throws(() => autoList.resolveAutoListPhotos(['/uploads/../etc/passwd'], ''), /outside the uploads directory/);
});
