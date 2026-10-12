const { startDatabase, resetDatabase, stopDatabase, commands } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');

const app = createApp();
const MONTH = '2026-09';
const SAME_TIME = new Date('2026-09-01T00:00:00Z');

// Inserts `count` events for MONTH, all with the same createdAt, every 4th one failed.
async function seedEvents(count) {
  const subscriptions = await Subscription.insertMany(
    Array.from({ length: count }, (_, i) => ({
      name: `Customer ${i}`,
      plan: 'Team',
      amount: 1000 + i,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date('2026-01-01T00:00:00Z'),
    })),
  );
  // Write raw documents so createdAt is identical (the worst case for paging stability).
  await RenewalEvent.collection.insertMany(
    subscriptions.map((s, i) => ({
      _id: new mongoose.Types.ObjectId(),
      subscription: s._id,
      billingMonth: MONTH,
      amount: s.amount,
      currency: 'USD',
      status: i % 4 === 0 ? 'failed' : 'charged',
      attempts: 1,
      createdAt: SAME_TIME,
      updatedAt: SAME_TIME,
    })),
  );
}

const getHistory = (query) => request(app).get('/api/renewals').query({ month: MONTH, ...query });

async function pageThrough(query) {
  const first = await getHistory({ ...query, page: 1 });
  const ids = [];
  for (let page = 1; page <= first.body.totalPages; page++) {
    const res = page === 1 ? first : await getHistory({ ...query, page });
    assert.equal(res.status, 200);
    assert.equal(res.body.page, page);
    ids.push(...res.body.events.map((e) => e.id));
  }
  return { first: first.body, ids };
}

describe('GET /api/renewals (performance, paging, status filter)', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  test('loads subscriptions with at most one query, not one per event', async () => {
    await seedEvents(120);
    commands.length = 0;

    const res = await getHistory({ pageSize: 100 });

    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 100);
    assert.ok(res.body.events.every((e) => e.subscription && e.subscription.name.startsWith('Customer ')));
    const subscriptionFinds = commands.filter(
      (c) => c.commandName === 'find' && c.command.find === 'subscriptions',
    );
    assert.ok(subscriptionFinds.length <= 1, `${subscriptionFinds.length} subscription queries`);
    const eventFinds = commands.filter((c) => c.commandName === 'find' && c.command.find === 'renewalevents');
    assert.equal(eventFinds.length, 1);
  });

  for (const pageSize of [50, 60, 200]) {
    test(`paging with pageSize ${pageSize} returns every event exactly once`, async () => {
      await seedEvents(250);

      const { first, ids } = await pageThrough({ pageSize });

      assert.equal(first.count, 250);
      assert.equal(first.totalPages, Math.ceil(250 / pageSize));
      assert.equal(ids.length, 250);
      assert.equal(new Set(ids).size, 250);
    });
  }

  test('a page beyond the range is empty but reports the real totalPages', async () => {
    await seedEvents(30);

    const res = await getHistory({ page: 6, pageSize: 10 });

    assert.equal(res.status, 200);
    assert.equal(res.body.count, 30);
    assert.equal(res.body.totalPages, 3);
    assert.equal(res.body.page, 6);
    assert.deepEqual(res.body.events, []);
  });

  test('an empty month has one (empty) page', async () => {
    const res = await getHistory({});
    assert.equal(res.body.count, 0);
    assert.equal(res.body.totalPages, 1);
    assert.equal(res.body.status, null);
  });

  test('the status filter drives count, totalPages and events', async () => {
    await seedEvents(250); // 63 failed, 187 charged

    const all = await getHistory({ pageSize: 50 });
    const failed = await getHistory({ pageSize: 50, status: 'failed' });
    const charged = await getHistory({ pageSize: 50, status: 'charged' });
    const scheduled = await getHistory({ pageSize: 50, status: 'scheduled' });

    assert.equal(all.body.count, 250);
    assert.equal(all.body.status, null);
    assert.equal(failed.body.status, 'failed');
    assert.equal(failed.body.count, 63);
    assert.equal(failed.body.totalPages, 2);
    assert.ok(failed.body.events.every((e) => e.status === 'failed'));
    assert.equal(charged.body.count, 187);
    assert.equal(charged.body.totalPages, 4);
    assert.equal(scheduled.body.count, 0);
    assert.deepEqual(scheduled.body.events, []);

    const { ids } = await pageThrough({ pageSize: 50, status: 'failed' });
    assert.equal(new Set(ids).size, 63);
  });

  test('an event whose subscription is gone is returned with subscription null', async () => {
    await RenewalEvent.create({ subscription: new mongoose.Types.ObjectId(), billingMonth: MONTH, amount: 100 });
    const res = await getHistory({});
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].subscription, null);
  });
});
