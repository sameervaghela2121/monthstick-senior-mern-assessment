const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');

const app = createApp();
const OCTOBER_DUE = ['Canva', 'Figma', 'GitHub Copilot', 'Netflix'];

const run = (month = '2026-10') => request(app).post('/api/renewals/run').send({ month });

describe('POST /api/renewals/run (duplicate prevention)', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(async () => {
    await resetDatabase();
    await seedSubscriptions();
  });

  test('first run creates the due events and reports them', async () => {
    const res = await run();

    assert.equal(res.status, 201);
    assert.equal(res.body.dueCount, 4);
    assert.equal(res.body.createdCount, 4);
    assert.equal(res.body.existingCount, 0);
    assert.deepEqual(res.body.created.map((e) => e.name).sort(), OCTOBER_DUE);
    assert.deepEqual(res.body.existing, []);
    for (const entry of res.body.created) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'subscriptionId']);
    }
  });

  test('a rerun creates nothing and lists the existing events', async () => {
    const first = await run();
    const second = await run();

    assert.equal(second.status, 200);
    assert.equal(second.body.dueCount, 4);
    assert.equal(second.body.createdCount, 0);
    assert.equal(second.body.existingCount, 4);
    assert.deepEqual(second.body.created, []);
    const byId = (a, b) => a.id.localeCompare(b.id);
    assert.deepEqual([...second.body.existing].sort(byId), [...first.body.created].sort(byId));
    assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
  });

  test('a run after a partial earlier run creates only the missing events', async () => {
    const netflix = await Subscription.findOne({ name: 'Netflix' });
    await RenewalEvent.create({ subscription: netflix._id, billingMonth: '2026-10', amount: netflix.amount });

    const res = await run();

    assert.equal(res.status, 201);
    assert.equal(res.body.createdCount, 3);
    assert.deepEqual(res.body.existing.map((e) => e.name), ['Netflix']);
    assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
  });

  test('concurrent runs create each event exactly once', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => run()));

    for (const res of responses) assert.ok([200, 201].includes(res.status), `status ${res.status}`);
    const totalCreated = responses.reduce((sum, res) => sum + res.body.createdCount, 0);
    assert.equal(totalCreated, 4);
    for (const res of responses) assert.equal(res.body.createdCount + res.body.existingCount, 4);
    assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
  });

  test('paused and cancelled subscriptions are never billed', async () => {
    await run('2026-10');
    await run('2026-11');
    const events = await RenewalEvent.find().populate('subscription').lean();
    const names = events.map((e) => e.subscription.name);
    assert.ok(!names.includes("Gold's Gym"));
    assert.ok(!names.includes('Adobe Creative Cloud'));
  });

  test('a non-duplicate database error is a 500, not silently swallowed', async () => {
    const original = RenewalEvent.insertMany;
    RenewalEvent.insertMany = async () => {
      throw new Error('connection reset by peer at 10.0.0.5');
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const res = await run();
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: { message: 'Internal Server Error' } });
    } finally {
      RenewalEvent.insertMany = original;
      console.error = originalConsoleError;
    }
  });

  test('a bulk error mixing duplicates and other write errors is a 500', async () => {
    const original = RenewalEvent.insertMany;
    RenewalEvent.insertMany = async () => {
      const err = new Error('bulk write failed');
      err.writeErrors = [{ err: { code: 11000 } }, { err: { code: 121 } }];
      err.insertedDocs = [];
      throw err;
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const res = await run();
      assert.equal(res.status, 500);
    } finally {
      RenewalEvent.insertMany = original;
      console.error = originalConsoleError;
    }
  });
});
