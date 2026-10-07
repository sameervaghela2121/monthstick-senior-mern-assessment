const { startDatabase, resetDatabase, stopDatabase, commands } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');

const app = createApp();
const MONTH = '2026-09';
const TOTAL = 23;

const history = (query) => request(app).get('/api/renewals').query({ month: MONTH, ...query });

// Every fifth event failed, every fifth is still scheduled, the rest were charged.
const statusFor = (i) => (i % 5 === 0 ? 'failed' : i % 5 === 1 ? 'scheduled' : 'charged');

// All events share one createdAt, like a bulk renewal run, so ordering needs a tie-breaker.
async function seedEvents(total = TOTAL) {
  const subscriptions = await Subscription.insertMany(
    Array.from({ length: total }, (_, i) => ({
      name: `Customer ${String(i + 1).padStart(3, '0')}`,
      plan: 'Team',
      amount: 1000 + i,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date('2026-01-01T00:00:00Z'),
    })),
  );
  const createdAt = new Date('2026-09-01T00:00:00Z');
  await RenewalEvent.insertMany(
    subscriptions.map((subscription, i) => ({
      subscription: subscription._id,
      billingMonth: MONTH,
      amount: subscription.amount,
      status: statusFor(i),
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    })),
  );
  return subscriptions;
}

async function collectAllPages(query) {
  const first = await history({ ...query, page: 1 });
  const events = [...first.body.events];
  for (let page = 2; page <= first.body.totalPages; page++) {
    events.push(...(await history({ ...query, page })).body.events);
  }
  return { first: first.body, events };
}

describe('GET /api/renewals: pagination, status filter and query cost', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(async () => {
    await resetDatabase();
    await seedEvents();
  });

  describe('pagination', () => {
    test('totalPages includes the final partial page', async () => {
      const res = await history({ page: 3, pageSize: 10 });

      assert.equal(res.status, 200);
      assert.equal(res.body.count, TOTAL);
      assert.equal(res.body.totalPages, 3);
      assert.equal(res.body.events.length, 3);
    });

    test('paging through a month returns every event exactly once, in a stable order', async () => {
      const { events } = await collectAllPages({ pageSize: 5 });
      const ids = events.map((event) => event.id);

      assert.equal(ids.length, TOTAL);
      assert.equal(new Set(ids).size, TOTAL);
      // createdAt is identical for every event, so _id decides the order.
      assert.deepEqual(ids, [...ids].sort());
    });

    test('an exact multiple of the page size does not add an empty page', async () => {
      const res = await history({ pageSize: TOTAL });
      assert.equal(res.body.totalPages, 1);
    });

    test('a page past the end is empty but still reports the real totals', async () => {
      const res = await history({ page: 9, pageSize: 10 });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.events, []);
      assert.equal(res.body.count, TOTAL);
      assert.equal(res.body.totalPages, 3);
    });
  });

  describe('status filter', () => {
    test('returns only events with the requested status', async () => {
      for (const status of ['scheduled', 'charged', 'failed']) {
        const res = await history({ status, pageSize: 200 });
        const expected = Array.from({ length: TOTAL }, (_, i) => statusFor(i)).filter((s) => s === status).length;

        assert.equal(res.status, 200);
        assert.equal(res.body.count, expected, `count for ${status}`);
        assert.equal(res.body.events.length, expected);
        assert.ok(res.body.events.every((event) => event.status === status));
      }
    });

    test('count, totalPages and paging reflect the filter', async () => {
      const { first, events } = await collectAllPages({ status: 'failed', pageSize: 2 });

      assert.equal(first.count, 5);
      assert.equal(first.totalPages, 3);
      assert.equal(first.events.length, 2);
      assert.equal(events.length, 5);
      assert.equal(new Set(events.map((event) => event.id)).size, 5);
      assert.ok(events.every((event) => event.status === 'failed'));
    });

    test('without a status (or with an empty one) every event is returned', async () => {
      assert.equal((await history({})).body.count, TOTAL);
      assert.equal((await history({ status: '' })).body.count, TOTAL);
    });

    test('an unknown status is rejected with 400', async () => {
      const res = await history({ status: 'refunded' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.details[0].field, 'status');
    });
  });

  describe('query cost', () => {
    test('the number of database commands does not grow with the number of rows', async () => {
      commands.length = 0;
      const res = await history({ pageSize: TOTAL });

      assert.equal(res.body.events.length, TOTAL);
      assert.ok(res.body.events.every((event) => event.subscription?.name));
      const queries = commands.filter((command) => ['find', 'aggregate', 'count', 'getMore'].includes(command.commandName));
      assert.ok(queries.length <= 2, `expected at most 2 queries, saw ${queries.length}`);
    });

    test('an event whose subscription was deleted is still listed', async () => {
      const orphan = await RenewalEvent.findOne({ billingMonth: MONTH });
      await Subscription.deleteOne({ _id: orphan.subscription });

      const res = await history({ pageSize: 200 });

      assert.equal(res.body.events.length, TOTAL);
      assert.equal(res.body.events.find((event) => event.id === String(orphan._id)).subscription, null);
    });

    for (const [label, filter] of [
      ['a month', { billingMonth: MONTH }],
      ['a month and status', { billingMonth: MONTH, status: 'failed' }],
    ]) {
      test(`history for ${label} is read from an index, already in order`, async () => {
        const plan = await RenewalEvent.find(filter).sort({ createdAt: 1, _id: 1 }).limit(10).explain('queryPlanner');
        const winningPlan = JSON.stringify(plan.queryPlanner.winningPlan);

        assert.ok(winningPlan.includes('IXSCAN'), `no index scan in ${winningPlan}`);
        assert.ok(!winningPlan.includes('COLLSCAN'), `collection scan in ${winningPlan}`);
        assert.ok(!winningPlan.includes('"SORT"'), `in-memory sort in ${winningPlan}`);
      });
    }
  });
});
