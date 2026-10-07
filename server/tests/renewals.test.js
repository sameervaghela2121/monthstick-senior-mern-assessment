const { startDatabase, resetDatabase, stopDatabase, commands } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');
const { paymentGateway, GatewayError } = require('../src/services/paymentGateway');

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

    test('running the same month again reports existing events and does not duplicate them', async () => {
      const first = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const second = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      assert.equal(first.body.createdCount, 4);
      assert.equal(first.body.alreadyExistedCount, 0);
      assert.equal(second.status, 200);
      assert.equal(second.body.createdCount, 0);
      assert.equal(second.body.alreadyExistedCount, 4);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
    });

    test('concurrent runs create one event per due subscription', async () => {
      await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post('/api/renewals/run').send({ month: '2026-10' }),
        ),
      );

      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
      assert.deepEqual(await namesForMonth('2026-10'), ['Canva', 'Figma', 'GitHub Copilot', 'Netflix']);
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

    test('includes the remainder page so every event is returned once', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      const first = await request(app).get('/api/renewals').query({ month: '2026-10', page: 1, pageSize: 3 });
      const second = await request(app).get('/api/renewals').query({ month: '2026-10', page: 2, pageSize: 3 });

      assert.equal(first.body.totalPages, 2);
      assert.equal(first.body.events.length, 3);
      assert.equal(second.body.events.length, 1);
      const ids = [...first.body.events, ...second.body.events].map((event) => event.id);
      assert.equal(new Set(ids).size, 4);
    });

    test('loads each page of subscriptions in one query', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      commands.length = 0;

      const res = await request(app).get('/api/renewals').query({ month: '2026-10' });

      assert.equal(res.status, 200);
      const subscriptionFinds = commands.filter(
        (command) => command.commandName === 'find' && command.command.find === 'subscriptions',
      );
      assert.equal(subscriptionFinds.length, 1);
    });

    test('filters history by status', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const netflix = await eventFor('Netflix', '2026-10');
      await request(app)
        .patch(`/api/renewals/${netflix._id}/status`)
        .send({ status: 'failed', failureReason: 'card_declined' });

      const failed = await request(app).get('/api/renewals').query({ month: '2026-10', status: 'failed' });
      assert.equal(failed.status, 200);
      assert.equal(failed.body.count, 1);
      assert.equal(failed.body.totalPages, 1);
      assert.equal(failed.body.events[0].subscription.name, 'Netflix');

      const scheduled = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'scheduled' });
      assert.equal(scheduled.body.count, 3);
      assert.ok(scheduled.body.events.every((event) => event.status === 'scheduled'));
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
      assert.equal(res.body.tax, 414 + 2592 + 180 + 191);
      assert.equal(res.body.total, res.body.subtotal + res.body.tax);
      assert.deepEqual(res.body.byStatus, { scheduled: 4, charged: 0, failed: 0 });
    });

    test('rounds GST half to even per event and updates after a charge', async () => {
      const netflix = await Subscription.findOne({ name: 'Netflix' });
      const figma = await Subscription.findOne({ name: 'Figma' });
      const [evenTie] = await RenewalEvent.create([
        { subscription: netflix._id, billingMonth: '2026-07', amount: 25, currency: 'USD' },
        { subscription: figma._id, billingMonth: '2026-07', amount: 75, currency: 'USD' },
      ]);

      const first = await request(app).get('/api/renewals/summary').query({ month: '2026-07' });
      assert.equal(first.body.subtotal, 100);
      assert.equal(first.body.tax, 18);
      assert.equal(first.body.total, 118);

      await request(app).patch(`/api/renewals/${evenTie._id}/status`).send({ status: 'charged' });
      const second = await request(app).get('/api/renewals/summary').query({ month: '2026-07' });
      assert.equal(second.body.tax, 18);
      assert.deepEqual(second.body.byStatus, { scheduled: 1, charged: 1, failed: 0 });
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

    test('keeps a charged event charged when a failed webhook arrives later', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });

      const res = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', failureReason: 'late_webhook' });

      assert.equal(res.status, 409);
      const saved = await eventFor('Netflix', '2026-10');
      assert.equal(saved.status, 'charged');
      assert.equal(saved.attempts, 2);
    });

    test('lets a later successful charge replace a failure', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Figma', '2026-10');
      await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', failureReason: 'card_declined' });

      const res = await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'charged');
      assert.equal(res.body.attempts, 2);
      assert.equal(res.body.failureReason, null);
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

    test('records a gateway error as a failed attempt', async () => {
      const original = paymentGateway.charge;
      paymentGateway.charge = async () => {
        throw new GatewayError('Too many concurrent requests', 429);
      };
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const event = await eventFor('Figma', '2026-10');
        event.status = 'failed';
        event.attempts = 1;
        await event.save();

        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });

        assert.equal(res.status, 200);
        assert.deepEqual(
          { retried: res.body.retried, charged: res.body.charged, failed: res.body.failed },
          { retried: 1, charged: 0, failed: 1 },
        );
        const saved = await eventFor('Figma', '2026-10');
        assert.equal(saved.status, 'failed');
        assert.equal(saved.attempts, 2);
        assert.equal(saved.failureReason, 'Too many concurrent requests');
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('charges each failed event once when retry is submitted twice together', async () => {
      const original = paymentGateway.charge;
      const seen = new Map();
      let calls = 0;
      paymentGateway.charge = (chargeRequest) => {
        const key = chargeRequest.idempotencyKey;
        if (key && seen.has(key)) return seen.get(key);
        const pending = Promise.resolve().then(() => {
          calls += 1;
          return { ok: true, chargeId: 'ch_once' };
        });
        if (key) seen.set(key, pending);
        return pending;
      };
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const event = await eventFor('Netflix', '2026-10');
        event.status = 'failed';
        event.failureReason = 'card_declined';
        await event.save();

        const [first, second] = await Promise.all([
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
        ]);

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(calls, 1);
        const saved = await eventFor('Netflix', '2026-10');
        assert.equal(saved.status, 'charged');
        assert.equal(saved.attempts, 1);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('retries with at most four charges in flight', async () => {
      const original = paymentGateway.charge;
      let inFlight = 0;
      let maxInFlight = 0;
      paymentGateway.charge = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { ok: false, reason: 'card_declined' };
      };
      try {
        const subscriptions = await Subscription.find();
        await RenewalEvent.insertMany(
          subscriptions.map((subscription) => ({
            subscription: subscription._id,
            billingMonth: '2026-04',
            amount: subscription.amount,
            currency: 'USD',
            status: 'failed',
            attempts: 1,
            failureReason: 'card_declined',
          })),
        );

        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-04' });

        assert.equal(res.status, 200);
        assert.equal(res.body.retried, subscriptions.length);
        assert.equal(res.body.failed, subscriptions.length);
        assert.ok(maxInFlight > 1 && maxInFlight <= 4, `saw ${maxInFlight} concurrent charges`);
      } finally {
        paymentGateway.charge = original;
      }
    });
  });

  describe('request validation', () => {
    test('rejects an invalid month, page, page size, status, and event id', async () => {
      const invalidMonth = await request(app).post('/api/renewals/run').send({ month: '2026-13' });
      assert.equal(invalidMonth.status, 400);
      assert.equal(invalidMonth.body.error.message, 'month must be YYYY-MM');
      assert.equal(invalidMonth.body.stack, undefined);
      assert.equal(invalidMonth.body.error.stack, undefined);

      const missingMonth = await request(app).get('/api/renewals/summary');
      assert.equal(missingMonth.status, 400);
      assert.equal(missingMonth.body.error.message, 'month must be YYYY-MM');

      const badPage = await request(app).get('/api/renewals').query({ month: '2026-10', page: 0 });
      assert.equal(badPage.status, 400);
      assert.equal(badPage.body.error.message, 'page must be an integer greater than or equal to 1');

      const badPageSize = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', pageSize: 201 });
      assert.equal(badPageSize.status, 400);
      assert.equal(badPageSize.body.error.message, 'pageSize must be an integer between 1 and 200');

      const badStatus = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'pending' });
      assert.equal(badStatus.status, 400);
      assert.equal(badStatus.body.error.message, 'status must be one of scheduled, charged, failed');

      const badId = await request(app).patch('/api/renewals/not-an-id/status').send({ status: 'charged' });
      assert.equal(badId.status, 400);
      assert.equal(badId.body.error.message, 'id must be a valid event id');

      const badUpdate = await request(app)
        .patch('/api/renewals/0123456789abcdef01234567/status')
        .send({ status: 'scheduled' });
      assert.equal(badUpdate.status, 400);
      assert.equal(badUpdate.body.error.message, 'status must be charged or failed');
    });
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
