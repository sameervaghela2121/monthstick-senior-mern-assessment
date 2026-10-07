const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions, seedDatabase } = require('../scripts/seedData');
const { paymentGateway, GatewayError } = require('../src/services/paymentGateway');
const { clearSummaryCache, taxCents } = require('../src/services/revenueSummary');
const { collapseDuplicateRenewalEvents } = require('../src/services/renewalIntegrity');

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
    clearSummaryCache();
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

    test('running the same month again reports existing events and does not duplicate them', async () => {
      const first = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const second = await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      assert.equal(first.body.createdCount, 4);
      assert.equal(first.body.alreadyExistedCount, 0);
      assert.equal(second.status, 200);
      assert.equal(second.body.createdCount, 0);
      assert.equal(second.body.alreadyExistedCount, 4);
      assert.equal(second.body.created.length, 0);
      assert.equal(second.body.alreadyExisted.length, 4);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
    });

    test('overlapping runs create one event per subscription', async () => {
      const [first, second] = await Promise.all([
        request(app).post('/api/renewals/run').send({ month: '2026-10' }),
        request(app).post('/api/renewals/run').send({ month: '2026-10' }),
      ]);

      assert.equal(first.body.createdCount + first.body.alreadyExistedCount, 4);
      assert.equal(second.body.createdCount + second.body.alreadyExistedCount, 4);
      assert.equal(first.body.createdCount + second.body.createdCount, 4);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
      assert.deepEqual(await namesForMonth('2026-10'), ['Canva', 'Figma', 'GitHub Copilot', 'Netflix']);
    });

    test('unexpected database errors are not reported as existing renewals', async () => {
      const original = RenewalEvent.create;
      RenewalEvent.create = async () => {
        const error = new Error('connection reset');
        error.code = 11600;
        throw error;
      };
      try {
        const res = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        assert.equal(res.status, 500);
        assert.equal(res.body.error.message, 'Internal Server Error');
        assert.equal(JSON.stringify(res.body).includes('connection reset'), false);
        assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 0);
      } finally {
        RenewalEvent.create = original;
      }
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
      const amounts = [2299, 14400, 1000, 1059];
      assert.equal(res.body.tax, amounts.reduce((sum, amount) => sum + taxCents(amount), 0));
      assert.equal(res.body.tax, 3377);
      assert.equal(res.body.total, res.body.subtotal + res.body.tax);
    });

    test('picks up new events and payment updates without a restart', async () => {
      const before = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.equal(before.body.eventCount, 0);

      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const afterRun = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.equal(afterRun.body.eventCount, 4);
      assert.equal(afterRun.body.byStatus.scheduled, 4);

      const event = await eventFor('Netflix', '2026-10');
      await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });
      const afterCharge = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.deepEqual(afterCharge.body.byStatus, { scheduled: 3, charged: 1, failed: 0 });
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

    test('a later failed webhook cannot overwrite a charged event', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');

      const [charged, failed] = await Promise.all([
        request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' }),
        request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'failed', failureReason: 'card_declined' }),
      ]);

      assert.equal(charged.status, 200);
      const saved = await eventFor('Netflix', '2026-10');
      assert.equal(saved.status, 'charged');
      const accepted = [charged, failed].filter((res) => res.status === 200);
      assert.equal(saved.attempts, accepted.length);
      assert.equal(failed.status === 200 || failed.status === 409, true);
    });

    test('counts every accepted webhook exactly once', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Figma', '2026-10');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .patch(`/api/renewals/${event._id}/status`)
            .send({ status: 'failed', failureReason: 'card_declined' }),
        ),
      );

      assert.equal(responses.every((res) => res.status === 200), true);
      const saved = await eventFor('Figma', '2026-10');
      assert.equal(saved.status, 'failed');
      assert.equal(saved.attempts, 5);
    });

    test('a repeated charged webhook does not add another attempt', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });

      const repeat = await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });
      const saved = await eventFor('Netflix', '2026-10');

      assert.equal(repeat.status, 409);
      assert.equal(saved.status, 'charged');
      assert.equal(saved.attempts, 1);
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
        assert.equal(res.body.charged, 0);
        assert.equal(res.body.failed, 0);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('retries failed charges and waits for the result', async () => {
      const original = paymentGateway.charge;
      paymentGateway.charge = async (chargeRequest) => {
        assert.match(chargeRequest.idempotencyKey, /^renewal:/);
        return { ok: true, chargeId: 'ch_test' };
      };
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const event = await eventFor('Figma', '2026-10');
        await request(app)
          .patch(`/api/renewals/${event._id}/status`)
          .send({ status: 'failed', failureReason: 'card_declined' });

        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        const saved = await eventFor('Figma', '2026-10');

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { month: '2026-10', retried: 1, charged: 1, failed: 0 });
        assert.equal(saved.status, 'charged');
        assert.equal(saved.attempts, 2);
        assert.equal(saved.failureReason, undefined);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('a gateway error is a failed attempt and does not fail the request', async () => {
      const original = paymentGateway.charge;
      paymentGateway.charge = async () => {
        throw new GatewayError('Too many concurrent requests', 429);
      };
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const event = await eventFor('Netflix', '2026-10');
        await request(app)
          .patch(`/api/renewals/${event._id}/status`)
          .send({ status: 'failed', failureReason: 'card_declined' });

        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        const saved = await eventFor('Netflix', '2026-10');

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { month: '2026-10', retried: 1, charged: 0, failed: 1 });
        assert.equal(saved.status, 'failed');
        assert.equal(saved.attempts, 2);
        assert.equal(saved.failureReason, 'Too many concurrent requests');
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('two overlapping retries record one charge for the same event', async () => {
      const original = paymentGateway.charge;
      const keys = [];
      paymentGateway.charge = async (chargeRequest) => {
        keys.push(chargeRequest.idempotencyKey);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true, chargeId: 'ch_once' };
      };
      try {
        await request(app).post('/api/renewals/run').send({ month: '2026-10' });
        const event = await eventFor('Canva', '2026-10');
        await request(app)
          .patch(`/api/renewals/${event._id}/status`)
          .send({ status: 'failed', failureReason: 'card_declined' });

        const [first, second] = await Promise.all([
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
        ]);
        const saved = await eventFor('Canva', '2026-10');

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(first.body.retried + second.body.retried, 1);
        assert.equal(saved.status, 'charged');
        assert.equal(saved.attempts, 2);
        assert.ok(keys.length >= 1);
        assert.equal(new Set(keys).size, 1);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('keeps at most four charge requests in flight', async () => {
      const original = paymentGateway.charge;
      let inFlight = 0;
      let maxInFlight = 0;
      paymentGateway.charge = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return { ok: true, chargeId: 'ch_test' };
      };
      try {
        const extras = await Subscription.insertMany(
          Array.from({ length: 8 }, (_, index) => ({
            name: `Retry Customer ${index}`,
            plan: 'Team',
            amount: 500,
            billingCycle: 'monthly',
            status: 'active',
            startDate: new Date('2026-01-01T00:00:00.000Z'),
          })),
        );
        await RenewalEvent.insertMany(
          extras.map((subscription) => ({
            subscription: subscription._id,
            billingMonth: '2026-07',
            amount: subscription.amount,
            currency: 'USD',
            status: 'failed',
            attempts: 1,
            failureReason: 'card_declined',
          })),
        );

        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-07' });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { month: '2026-07', retried: 8, charged: 8, failed: 0 });
        assert.equal(maxInFlight, 4);
      } finally {
        paymentGateway.charge = original;
      }
    });
  });

  test('existing duplicate renewal events can be collapsed without editing the seed file', async () => {
    await Subscription.deleteMany({});
    await RenewalEvent.deleteMany({});
    await RenewalEvent.collection.dropIndex('uniq_subscription_billingMonth').catch(() => {});
    try {
      await seedDatabase();
      const netflix = await Subscription.findOne({ name: 'Netflix' });
      assert.equal(await RenewalEvent.countDocuments({ subscription: netflix._id, billingMonth: '2026-08' }), 2);
      assert.equal(await RenewalEvent.countDocuments({ subscription: netflix._id, billingMonth: '2026-09' }), 2);

      const removed = await collapseDuplicateRenewalEvents();
      assert.equal(removed.length, 2);
      assert.equal(await RenewalEvent.countDocuments({ subscription: netflix._id, billingMonth: '2026-08' }), 1);
      assert.equal(await RenewalEvent.countDocuments({ subscription: netflix._id, billingMonth: '2026-09' }), 1);

      const kept = await RenewalEvent.findOne({ subscription: netflix._id, billingMonth: '2026-09' });
      assert.equal(kept.status, 'charged');
      await RenewalEvent.syncIndexes();
      await assert.rejects(
        RenewalEvent.create({
          subscription: netflix._id,
          billingMonth: '2026-09',
          amount: netflix.amount,
        }),
        (err) => err.code === 11000,
      );
    } finally {
      await collapseDuplicateRenewalEvents();
      await RenewalEvent.syncIndexes();
    }
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
