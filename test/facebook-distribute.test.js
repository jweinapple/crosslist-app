// Unit tests for server/facebook-distribute.js — job queue logic only.
// No browser, no Facebook, no network. The extension side cannot be unit
// tested here; it is exercised via the uniform interface contract.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'crosslist-fbdist-'));
process.env.DATA_DIR = dataDir;

// db.js reads DATA_DIR at import time; import it first, then the module
// under test (it shares the same db handle via module cache).
const userStore = await import('../server/db.js');
const fbDistribute = await import('../server/facebook-distribute.js');

const USER_ID = 'user_fb_distribute_test';
const OTHER_USER = 'user_fb_distribute_other';

before(() => {
  const now = new Date().toISOString();
  for (const [id, email] of [
    [USER_ID, 'fb-distribute-test@example.com'],
    [OTHER_USER, 'fb-distribute-other@example.com'],
  ]) {
    userStore.db
      .prepare(
        'INSERT OR IGNORE INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, email, 'hash', 'Test', now, now);
  }
});

function baseInput(overrides = {}) {
  return {
    identity: {
      brand: 'Fender',
      model: "Vintera Road Worn '50s Stratocaster",
      name: 'Stratocaster',
      color: 'Surf Green',
      condition: 'Good',
    },
    price: 655,
    photoPaths: [],
    photoUrls: ['https://example.com/photo1.jpg'],
    ...overrides,
  };
}

test('distribute() returns the uniform interface and queues a pending job', async () => {
  const result = await fbDistribute.distribute(baseInput(), {
    userId: USER_ID,
    dashboardOrigin: 'http://localhost:3000',
    source: 'test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.marketplace, 'facebook');
  assert.equal(result.status, 'pending');
  assert.match(result.jobId, /^[0-9a-f-]{36}$/);

  const job = fbDistribute.getJob(result.jobId);
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  // Title is assembled from the identity fields: brand + name + color.
  assert.equal(job.payload.title, 'Fender Stratocaster Surf Green');
  assert.match(job.payload.description, /Surf Green/);
  assert.equal(job.payload.price, 655);
  assert.deepEqual(job.payload.images, ['https://example.com/photo1.jpg']);
  assert.equal(job.payload.dashboardOrigin, 'http://localhost:3000');
});

test('distribute() accepts ctx.user.id like the auto-distribute orchestrator', async () => {
  const result = await fbDistribute.distribute(baseInput(), { user: { id: USER_ID } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending');
  assert.equal(fbDistribute.getJob(result.jobId).userId, USER_ID);
});

test('distribute() embeds local photo files as data URLs', async () => {
  // Minimal 1x1 PNG bytes.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478' +
      '9c6360000000020001e221bc330000000049454e44ae426082',
    'hex'
  );
  const photoPath = path.join(dataDir, 'strat.png');
  writeFileSync(photoPath, png);

  const result = await fbDistribute.distribute(
    baseInput({ photoUrls: [], photoPaths: [photoPath, '/does/not/exist.jpg'] }),
    { userId: USER_ID }
  );
  assert.equal(result.ok, true);
  const job = fbDistribute.getJob(result.jobId);
  assert.equal(job.payload.images.length, 1);
  assert.ok(job.payload.images[0].startsWith('data:image/png;base64,'));
});

test('distribute() fails honestly on missing title, price, or user', async () => {
  const noTitle = await fbDistribute.distribute(baseInput({ identity: {} }), { userId: USER_ID });
  assert.equal(noTitle.ok, false);
  assert.equal(noTitle.status, 'failed');
  assert.equal(noTitle.marketplace, 'facebook');
  assert.ok(noTitle.error);

  const noPrice = await fbDistribute.distribute(baseInput({ price: 0 }), { userId: USER_ID });
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.status, 'failed');

  const noUser = await fbDistribute.distribute(baseInput(), {});
  assert.equal(noUser.ok, false);
  assert.equal(noUser.error, 'Missing userId in ctx');

  // Failed validations must not leave job rows behind.
  assert.equal(
    userStore.db.prepare("SELECT COUNT(*) AS n FROM fb_distribution_jobs WHERE status = 'failed'").get().n,
    0
  );
});

test('listPendingJobs() only returns pending jobs for the requesting user', async () => {
  const mine = await fbDistribute.distribute(baseInput(), { userId: USER_ID });
  const theirs = await fbDistribute.distribute(baseInput(), { userId: OTHER_USER });
  fbDistribute.claimJob(theirs.jobId);

  const pending = fbDistribute.listPendingJobs(USER_ID);
  const ids = pending.map((job) => job.jobId);
  assert.ok(ids.includes(mine.jobId));
  assert.ok(!ids.includes(theirs.jobId));
  assert.ok(pending.every((job) => job.status === 'pending'));
  assert.ok(pending.every((job) => job.userId === USER_ID));

  const otherPending = fbDistribute.listPendingJobs(OTHER_USER);
  assert.equal(otherPending.length, 0);
});

test('claimJob() transitions pending -> claimed exactly once', async () => {
  const created = await fbDistribute.distribute(baseInput(), { userId: USER_ID });
  const claimed = fbDistribute.claimJob(created.jobId);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.attempts, 1);

  assert.equal(fbDistribute.claimJob(created.jobId), null);
  assert.equal(fbDistribute.claimJob('00000000-0000-4000-8000-000000000000'), null);
});

test('completeFacebookJob() marks success done and logs it', async () => {
  const created = await fbDistribute.distribute(baseInput(), { userId: USER_ID });
  const result = fbDistribute.completeFacebookJob(USER_ID, created.jobId, {
    success: true,
    published: true,
    listingId: '1234567890',
    url: 'https://www.facebook.com/marketplace/item/1234567890',
    verification: 'redirect',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.equal(fbDistribute.getJob(created.jobId).status, 'done');

  const activity = userStore.listActivity(USER_ID, 500);
  const entry = activity.find((row) => row.detail?.jobId === created.jobId && row.type === 'success');
  assert.ok(entry);
  assert.match(entry.message, /Facebook listing published/);
});

test('completeFacebookJob() records failures via listing-failures.js, deduplicated', async () => {
  const created = await fbDistribute.distribute(baseInput(), { userId: USER_ID });
  const failureResult = {
    success: false,
    error: 'Publish button not found or disabled',
    step: 'publishing the listing',
    needsReview: true,
    trace: [{ at: new Date().toISOString(), message: 'Composer ready' }],
  };
  const result = fbDistribute.completeFacebookJob(USER_ID, created.jobId, failureResult);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(fbDistribute.getJob(created.jobId).status, 'failed');

  const activity = userStore.listActivity(USER_ID, 500);
  const entries = activity.filter((row) => row.detail?.jobId === created.jobId && row.type === 'error');
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /Facebook listing failed/);
  assert.ok(entries[0].detail.failureId);
  assert.equal(entries[0].detail.platform, 'facebook');

  // Re-reporting the same job is idempotent — no duplicate failure record.
  const repeat = fbDistribute.completeFacebookJob(USER_ID, created.jobId, failureResult);
  assert.equal(repeat.already, true);
  const after = userStore
    .listActivity(USER_ID, 500)
    .filter((row) => row.detail?.jobId === created.jobId && row.type === 'error');
  assert.equal(after.length, 1);
});

test('completeFacebookJob() rejects unknown jobs and other users', () => {
  const unknown = fbDistribute.completeFacebookJob(
    USER_ID,
    '00000000-0000-4000-8000-000000000000',
    { success: true }
  );
  assert.equal(unknown.ok, false);

  return fbDistribute.distribute(baseInput(), { userId: OTHER_USER }).then((created) => {
    const wrongUser = fbDistribute.completeFacebookJob(USER_ID, created.jobId, { success: true });
    assert.equal(wrongUser.ok, false);
    assert.match(wrongUser.error, /different user/);
  });
});

after(() => {
  userStore.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
