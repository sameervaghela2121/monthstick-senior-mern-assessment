const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent } = require('../src/models');
const { seedSubscriptions, seedLargeDataset } = require('../scripts/seedData');
const { startDatabase, resetDatabase, stopDatabase, commands } = require('./helpers/db');

const app = createApp();

async function namesForMonth(month) {
  const events = await RenewalEvent.find({ billingMonth: month }).populate('subscription').lean();
  return events.map((e) => e.subscription.name).sort();
}

before(startDatabase);
after(stopDatabase);

describe('Renewals API', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSubscriptions();
  });

  test('GET /api/health responds', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  test('running October renewals creates events only for active subscriptions due in October', async () => {
    const res = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

    assert.ok([200, 201].includes(res.status), `unexpected status ${res.status}`);
    assert.equal(res.body.month, '2026-10');
    assert.equal(res.body.createdCount, 3);
    assert.deepEqual(await namesForMonth('2026-10'), ['Figma', 'GitHub Copilot', 'Netflix']);
  });

  test('running November renewals includes yearly anniversaries and new subscriptions', async () => {
    await request(app).post('/api/renewals/run').send({ month: '2026-11' });
    assert.deepEqual(await namesForMonth('2026-11'), ['GitHub Copilot', 'Netflix', 'Notion', 'Spotify']);
  });

  test('paused and cancelled subscriptions never create renewal events', async () => {
    await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    await request(app).post('/api/renewals/run').send({ month: '2026-11' });

    const names = [...(await namesForMonth('2026-10')), ...(await namesForMonth('2026-11'))];
    assert.ok(!names.includes("Gold's Gym"));
    assert.ok(!names.includes('Adobe Creative Cloud'));
  });

  test('GET /api/renewals returns history for the month with subscription details', async () => {
    await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    await request(app).post('/api/renewals/run').send({ month: '2026-11' });

    const res = await request(app).get('/api/renewals').query({ month: '2026-10' });

    assert.equal(res.status, 200);
    assert.equal(res.body.month, '2026-10');
    assert.equal(res.body.count, 3);
    assert.equal(res.body.events.length, 3);

    const netflix = res.body.events.find((e) => e.subscription.name === 'Netflix');
    assert.ok(netflix, 'Netflix event missing');
    assert.equal(typeof netflix.id, 'string');
    assert.equal(netflix.billingMonth, '2026-10');
    assert.equal(netflix.amount, 2299);
    assert.equal(netflix.currency, 'USD');
    assert.equal(netflix.status, 'scheduled');
    assert.ok(netflix.createdAt);
    assert.deepEqual(Object.keys(netflix.subscription).sort(), ['billingCycle', 'id', 'name', 'plan']);
    assert.equal(netflix.subscription.plan, 'Premium');
    assert.equal(netflix.subscription.billingCycle, 'monthly');
  });

  test('GET /api/renewals returns an empty list for a month without renewals', async () => {
    const res = await request(app).get('/api/renewals').query({ month: '2026-12' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { month: '2026-12', count: 0, events: [] });
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});

describe('Renewal runs are idempotent', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSubscriptions();
  });

  test('re-running a month creates nothing new and reports what already existed', async () => {
    const first = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    const second = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

    assert.equal(first.status, 201);
    assert.equal(first.body.createdCount, 3);
    assert.equal(first.body.alreadyExistedCount, 0);
    assert.deepEqual(first.body.created.map((c) => c.name).sort(), ['Figma', 'GitHub Copilot', 'Netflix']);
    assert.ok(first.body.created.every((c) => typeof c.eventId === 'string' && typeof c.subscriptionId === 'string'));

    assert.equal(second.status, 200);
    assert.equal(second.body.dueCount, 3);
    assert.equal(second.body.createdCount, 0);
    assert.equal(second.body.alreadyExistedCount, 3);
    assert.deepEqual(second.body.alreadyExisted.map((c) => c.name).sort(), ['Figma', 'GitHub Copilot', 'Netflix']);

    assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 3);
  });

  test('a re-run does not modify existing events', async () => {
    await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    await RenewalEvent.updateMany({ billingMonth: '2026-10' }, { status: 'charged' });
    const original = await RenewalEvent.find({ billingMonth: '2026-10' }).sort({ _id: 1 }).lean();

    await request(app).post('/api/renewals/run').send({ month: '2026-10' });

    const current = await RenewalEvent.find({ billingMonth: '2026-10' }).sort({ _id: 1 }).lean();
    assert.deepEqual(current, original);
  });

  test('concurrent runs for the same month never create duplicates', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post('/api/renewals/run').send({ month: '2026-10' })),
    );

    assert.ok(responses.every((res) => [200, 201].includes(res.status)));
    const totalCreated = responses.reduce((sum, res) => sum + res.body.createdCount, 0);
    assert.equal(totalCreated, 3);
    assert.deepEqual(await namesForMonth('2026-10'), ['Figma', 'GitHub Copilot', 'Netflix']);
  });

  test('the database itself rejects a duplicate event for the same subscription and month', async () => {
    await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    const existing = await RenewalEvent.findOne({ billingMonth: '2026-10' }).lean();

    await assert.rejects(
      RenewalEvent.create({ subscription: existing.subscription, billingMonth: '2026-10', amount: 1 }),
      { code: 11000 },
    );
  });

  test('unexpected database errors are not swallowed and do not leak details', async (t) => {
    t.mock.method(RenewalEvent, 'bulkWrite', async () => {
      throw new Error('connection reset by peer: secret-host:27017');
    });
    t.mock.method(console, 'error', () => {});

    const res = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
  });
});

describe('Month validation', () => {
  beforeEach(resetDatabase);


  const invalidMonths = ['2026-13', '2026-00', '2026-1', '26-10', '2026/10', '2026-10-01', 'October', '', ' 2026-10'];

  for (const month of invalidMonths) {
    test(`POST /api/renewals/run rejects ${JSON.stringify(month)} with 400`, async () => {
      const res = await request(app).post('/api/renewals/run').send({ month });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_MONTH');
      assert.equal(res.body.error.field, 'month');
      assert.match(res.body.error.message, /YYYY-MM/);
    });

    test(`GET /api/renewals rejects ${JSON.stringify(month)} with 400`, async () => {
      const res = await request(app).get('/api/renewals').query({ month });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_MONTH');
    });
  }

  test('rejects a missing month and non-string values', async () => {
    for (const body of [{}, { month: 202610 }, { month: ['2026-10'] }, { month: null }]) {
      const res = await request(app).post('/api/renewals/run').send(body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    const missing = await request(app).get('/api/renewals');
    assert.equal(missing.status, 400);

    const repeated = await request(app).get('/api/renewals?month=2026-10&month=2026-11');
    assert.equal(repeated.status, 400);
  });

  test('rejects malformed JSON without exposing parser internals', async () => {
    const res = await request(app)
      .post('/api/renewals/run')
      .set('Content-Type', 'application/json')
      .send('{"month": ');

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
  });
});

describe('Renewal history performance', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedLargeDataset(200);
  });

  test('history is served by a single database command regardless of the number of events', async () => {
    commands.length = 0;
    const res = await request(app).get('/api/renewals').query({ month: '2026-09' });

    assert.equal(res.status, 200);
    assert.equal(res.body.count, 180);
    assert.equal(res.body.events.length, 180);
    assert.ok(res.body.events.every((e) => e.subscription && e.subscription.name));

    // getMore is excluded: it fetches the next batch of the same cursor, not a new query.
    const queries = commands.filter((c) => ['find', 'aggregate', 'count'].includes(c.commandName));
    assert.equal(queries.length, 1, `expected 1 query, got: ${queries.map((c) => c.commandName).join(', ')}`);
  });

  test('history uses the billingMonth index instead of a collection scan', async () => {
    const plan = await RenewalEvent.find({ billingMonth: '2026-09' }).sort({ createdAt: 1, _id: 1 }).explain();
    const stages = JSON.stringify(plan.queryPlanner.winningPlan);

    assert.match(stages, /billingMonth_1_createdAt_1__id_1/);
    assert.doesNotMatch(stages, /COLLSCAN/);
  });
});
