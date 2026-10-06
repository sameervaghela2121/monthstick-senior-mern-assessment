const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');
const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');

const app = createApp();

async function namesForMonth(month) {
  const events = await RenewalEvent.find({ billingMonth: month }).populate('subscription').lean();
  return events.map((e) => e.subscription.name).sort();
}

describe('Renewals API', () => {
  before(startDatabase);
  after(stopDatabase);
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
