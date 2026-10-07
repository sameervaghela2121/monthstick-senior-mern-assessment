const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions, seedDatabase } = require('../scripts/seedData');

const app = createApp();

const run = (month) => request(app).post('/api/renewals/run').send({ month });

async function eventsPerSubscription(month) {
  const events = await RenewalEvent.find({ billingMonth: month }).populate('subscription').lean();
  const counts = {};
  for (const event of events) {
    counts[event.subscription.name] = (counts[event.subscription.name] ?? 0) + 1;
  }
  return counts;
}

describe('POST /api/renewals/run: at most one event per subscription and month', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);
  afterEach(() => mock.restoreAll());

  describe('with clean data', () => {
    beforeEach(seedSubscriptions);

    test('re-running a month creates nothing new and reports what already existed', async () => {
      const first = await run('2026-10');
      const second = await run('2026-10');

      assert.equal(first.status, 201);
      assert.equal(first.body.dueCount, 4);
      assert.equal(first.body.createdCount, 4);
      assert.equal(first.body.existingCount, 0);
      assert.deepEqual(first.body.created.map((s) => s.name).sort(), ['Canva', 'Figma', 'GitHub Copilot', 'Netflix']);

      assert.equal(second.status, 200);
      assert.equal(second.body.dueCount, 4);
      assert.equal(second.body.createdCount, 0);
      assert.equal(second.body.existingCount, 4);
      assert.deepEqual(second.body.created, []);
      assert.deepEqual(second.body.existing.map((s) => s.name).sort(), ['Canva', 'Figma', 'GitHub Copilot', 'Netflix']);

      assert.deepEqual(await eventsPerSubscription('2026-10'), { Canva: 1, Figma: 1, 'GitHub Copilot': 1, Netflix: 1 });
    });

    test('concurrent runs create exactly one event per subscription', async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => run('2026-10')));

      for (const res of responses) {
        assert.ok([200, 201].includes(res.status), `unexpected status ${res.status}`);
        assert.equal(res.body.createdCount + res.body.existingCount, 4);
      }
      assert.deepEqual(await eventsPerSubscription('2026-10'), { Canva: 1, Figma: 1, 'GitHub Copilot': 1, Netflix: 1 });
      // Each event is reported as "created" by the one request that actually wrote it.
      assert.equal(responses.reduce((total, res) => total + res.body.createdCount, 0), 4);
    });

    test('the database itself rejects a second event for the same subscription and month', async () => {
      const netflix = await Subscription.findOne({ name: 'Netflix' });
      const event = { subscription: netflix._id, billingMonth: '2026-10', amount: 2299, uniquePerMonth: true };

      await RenewalEvent.create(event);
      await assert.rejects(RenewalEvent.create(event), (err) => err.code === 11000);
    });

    test('an unexpected database error is reported, not swallowed', async () => {
      mock.method(console, 'error', () => {});
      mock.method(RenewalEvent, 'insertMany', async () => {
        throw new Error('connection to shard-00 lost');
      });

      const res = await run('2026-10');

      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: { message: 'Internal Server Error' } });
    });

    test('bills a subscription that starts late on 31 October UTC when the server is in Asia/Kolkata', async () => {
      process.env.TZ = 'Asia/Kolkata';
      try {
        const res = await run('2026-10');
        assert.equal(res.body.createdCount, 4);
        assert.equal((await eventsPerSubscription('2026-10')).Canva, 1);
      } finally {
        process.env.TZ = 'UTC';
      }
    });
  });

  describe('against the production snapshot, which already contains duplicates', () => {
    beforeEach(() => seedDatabase());

    test('the indexes can be built over the existing duplicates', async () => {
      await RenewalEvent.collection.dropIndexes();
      await RenewalEvent.createIndexes();

      const indexes = await RenewalEvent.collection.indexes();
      assert.ok(
        indexes.some((index) => index.unique && index.key.subscription === 1 && index.key.billingMonth === 1),
        'unique index on subscription + billingMonth is missing',
      );
    });

    test('re-running September adds nothing and leaves the legacy rows untouched', async () => {
      const before = await eventsPerSubscription('2026-09');
      assert.deepEqual(before, { Netflix: 2, 'GitHub Copilot': 1 });

      const responses = await Promise.all([run('2026-09'), run('2026-09'), run('2026-09')]);

      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.equal(res.body.createdCount, 0);
        assert.equal(res.body.existingCount, 2);
      }
      assert.deepEqual(await eventsPerSubscription('2026-09'), before);
    });

    test('concurrent October runs still create exactly one event per subscription', async () => {
      await Promise.all(Array.from({ length: 6 }, () => run('2026-10')));

      assert.deepEqual(await eventsPerSubscription('2026-10'), { Canva: 1, Figma: 1, 'GitHub Copilot': 1, Netflix: 1 });
    });
  });
});
