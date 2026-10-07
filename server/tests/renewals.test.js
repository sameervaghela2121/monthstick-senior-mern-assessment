const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');
const { paymentGateway } = require('../src/services/paymentGateway');

const app = createApp();

async function namesForMonth(month) {
  const events = await RenewalEvent.find({ billingMonth: month }).populate('subscription').lean();
  return events.map((e) => e.subscription.name).sort();
}

async function eventFor(name, month) {
  const subscription = await Subscription.findOne({ name });
  return RenewalEvent.findOne({ subscription: subscription._id, billingMonth: month });
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

  describe('POST /api/renewals/run', () => {
    test('creates events only for active subscriptions due in October', async () => {
      const res = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      assert.ok([200, 201].includes(res.status), `unexpected status ${res.status}`);
      assert.equal(res.body.month, '2026-10');
      assert.equal(res.body.createdCount, 4);
      assert.deepEqual(await namesForMonth('2026-10'), ['Canva', 'Figma', 'GitHub Copilot', 'Netflix']);
    });

    test('includes yearly anniversaries and new subscriptions in November', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-11' });
      assert.deepEqual(await namesForMonth('2026-11'), ['Canva', 'GitHub Copilot', 'Netflix', 'Notion', 'Spotify']);
    });

    test('paused and cancelled subscriptions never create renewal events', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      await request(app).post('/api/renewals/run').send({ month: '2026-11' });

      const names = [...(await namesForMonth('2026-10')), ...(await namesForMonth('2026-11'))];
      assert.ok(!names.includes("Gold's Gym"));
      assert.ok(!names.includes('Adobe Creative Cloud'));
    });
  });

  describe('GET /api/renewals', () => {
    test('returns paginated history for the month with subscription details', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      await request(app).post('/api/renewals/run').send({ month: '2026-11' });

      const res = await request(app).get('/api/renewals').query({ month: '2026-10' });

      assert.equal(res.status, 200);
      assert.equal(res.body.month, '2026-10');
      assert.equal(res.body.count, 4);
      assert.equal(res.body.page, 1);
      assert.equal(res.body.pageSize, 50);
      assert.equal(res.body.totalPages, 1);
      assert.equal(res.body.events.length, 4);

      const netflix = res.body.events.find((e) => e.subscription.name === 'Netflix');
      assert.ok(netflix, 'Netflix event missing');
      assert.equal(typeof netflix.id, 'string');
      assert.equal(netflix.billingMonth, '2026-10');
      assert.equal(netflix.amount, 2299);
      assert.equal(netflix.currency, 'USD');
      assert.equal(netflix.status, 'scheduled');
      assert.equal(netflix.attempts, 0);
      assert.equal(netflix.failureReason, null);
      assert.equal(netflix.chargedAt, null);
      assert.ok(netflix.createdAt);
      assert.deepEqual(Object.keys(netflix.subscription).sort(), ['billingCycle', 'id', 'name', 'plan']);
      assert.equal(netflix.subscription.plan, 'Premium');
    });

    test('returns the next page of events', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      const first = await request(app).get('/api/renewals').query({ month: '2026-10', page: 1, pageSize: 2 });
      const second = await request(app).get('/api/renewals').query({ month: '2026-10', page: 2, pageSize: 2 });

      assert.equal(first.body.events.length, 2);
      assert.equal(second.body.events.length, 2);
      assert.equal(second.body.page, 2);
      const ids = [...first.body.events, ...second.body.events].map((e) => e.id);
      assert.equal(new Set(ids).size, 4);
    });

    test('returns an empty list for a month without renewals', async () => {
      const res = await request(app).get('/api/renewals').query({ month: '2026-12' });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 0);
      assert.deepEqual(res.body.events, []);
    });
  });

  describe('GET /api/renewals/summary', () => {
    test('summarises the month after a renewal run', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      const res = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });

      assert.equal(res.status, 200);
      assert.equal(res.body.month, '2026-10');
      assert.equal(res.body.eventCount, 4);
      assert.equal(res.body.subtotal, 2299 + 14400 + 1000 + 1059);
      assert.deepEqual(res.body.byStatus, { scheduled: 4, charged: 0, failed: 0 });
      assert.equal(typeof res.body.tax, 'number');
      assert.equal(typeof res.body.total, 'number');
    });
  });

  describe('PATCH /api/renewals/:id/status', () => {
    test('records a successful charge', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');

      const res = await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'charged');
      assert.equal(res.body.attempts, 1);
      assert.ok(res.body.chargedAt);
    });

    test('records a failed charge with its reason', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Figma', '2026-10');

      const res = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', failureReason: 'insufficient_funds' });

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'failed');
      assert.equal(res.body.failureReason, 'insufficient_funds');
    });

    test('rejects changing a charged event back to failed', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });

      const res = await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'failed' });

      assert.equal(res.status, 409);
      assert.ok(res.body.error);
    });

    test('returns 404 for an unknown event', async () => {
      const res = await request(app)
        .patch('/api/renewals/0123456789abcdef01234567/status')
        .send({ status: 'charged' });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/renewals/retry-failed', () => {
    test('reports nothing to retry when no charges failed', async () => {
      const original = paymentGateway.charge;
      paymentGateway.charge = async () => ({ ok: true, chargeId: 'ch_test' });
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        assert.equal(res.status, 200);
        assert.equal(res.body.month, '2026-10');
        assert.equal(res.body.retried, 0);
      } finally {
        paymentGateway.charge = original;
      }
    });
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
