const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');
const { paymentGateway } = require('../src/services/paymentGateway');
const { clearSummaryCache } = require('../src/services/revenueSummary');

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

  test('rejects invalid month values across renewal endpoints', async () => {
    const run = await request(app).post('/api/renewals/run').send({ month: '2026-13' });
    const history = await request(app).get('/api/renewals').query({ month: '2026-00' });
    const summary = await request(app).get('/api/renewals/summary').query({ month: 'not-a-month' });
    const retry = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-1' });

    for (const response of [run, history, summary, retry]) {
      assert.equal(response.status, 400);
      assert.ok(response.body.error.message);
    }
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

    test('concurrent runs rely on the unique index and report created versus existing events', async () => {
      const [first, second] = await Promise.all([
        request(app).post('/api/renewals/run').send({ month: '2026-10' }),
        request(app).post('/api/renewals/run').send({ month: '2026-10' }),
      ]);

      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(first.body.createdCount + second.body.createdCount, 4);
      assert.equal(first.body.existingCount + second.body.existingCount, 4);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10' }), 4);
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

    test('filters results and pagination metadata by status', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const figma = await eventFor('Figma', '2026-10');
      const netflix = await eventFor('Netflix', '2026-10');
      await RenewalEvent.updateOne({ _id: figma._id }, { $set: { status: 'failed' } });
      await RenewalEvent.updateOne({ _id: netflix._id }, { $set: { status: 'charged' } });

      const res = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'failed', pageSize: 1 });

      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.totalPages, 1);
      assert.equal(res.body.events.length, 1);
      assert.equal(res.body.events[0].status, 'failed');
      assert.equal(res.body.events[0].subscription.name, 'Figma');
    });

    test('rejects invalid pagination and status filter values', async () => {
      for (const query of [
        { month: '2026-10', page: '0' },
        { month: '2026-10', pageSize: '201' },
        { month: '2026-10', status: 'pending' },
      ]) {
        const res = await request(app).get('/api/renewals').query(query);
        assert.equal(res.status, 400);
        assert.ok(res.body.error.message);
      }
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

    test('rounds GST per event using ties-to-even', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const events = await RenewalEvent.find({ billingMonth: '2026-10' }).sort({ _id: 1 });
      await RenewalEvent.updateOne({ _id: events[0]._id }, { $set: { amount: 25 } });
      await RenewalEvent.updateOne({ _id: events[1]._id }, { $set: { amount: 75 } });
      await RenewalEvent.updateOne({ _id: events[2]._id }, { $set: { amount: 1 } });
      await RenewalEvent.updateOne({ _id: events[3]._id }, { $set: { amount: 0 } });
      clearSummaryCache();

      const res = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.equal(res.body.subtotal, 101);
      assert.equal(res.body.tax, 18);
      assert.equal(res.body.total, 119);
    });
  });

  describe('PATCH /api/renewals/:id/status', () => {
    test('records a successful charge', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');

      const res = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'charged', attemptId: 'provider-attempt-1' });

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
        .send({ status: 'failed', failureReason: 'insufficient_funds', attemptId: 'provider-attempt-2' });

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'failed');
      assert.equal(res.body.failureReason, 'insufficient_funds');
    });

    test('rejects changing a charged event back to failed', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'charged', attemptId: 'provider-attempt-3' });

      const res = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', attemptId: 'provider-attempt-4' });

      assert.equal(res.status, 409);
      assert.ok(res.body.error);
    });

    test('returns 404 for an unknown event', async () => {
      const res = await request(app)
        .patch('/api/renewals/0123456789abcdef01234567/status')
        .send({ status: 'charged', attemptId: 'provider-attempt-5' });
      assert.equal(res.status, 404);
    });

    test('rejects malformed ids and invalid webhook fields with 400', async () => {
      const invalidId = await request(app)
        .patch('/api/renewals/not-an-object-id/status')
        .send({ status: 'charged', attemptId: 'provider-attempt-6' });
      assert.equal(invalidId.status, 400);

      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      const invalidReason = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', failureReason: { internal: true }, attemptId: 'provider-attempt-7' });
      assert.equal(invalidReason.status, 400);

      const missingAttemptId = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed' });
      assert.equal(missingAttemptId.status, 400);
    });

    test('deduplicates webhook deliveries and does not allow late failures to downgrade a charge', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const event = await eventFor('Netflix', '2026-10');
      const payload = { status: 'failed', failureReason: 'declined', attemptId: 'gateway-event-1' };
      const first = await request(app).patch(`/api/renewals/${event._id}/status`).send(payload);
      const duplicate = await request(app).patch(`/api/renewals/${event._id}/status`).send(payload);

      assert.equal(first.status, 200);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.attempts, 1);

      const charged = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'charged', attemptId: 'gateway-event-2' });
      const duplicateCharge = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'charged', attemptId: 'gateway-event-2' });
      const lateFailure = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'failed', attemptId: 'gateway-event-3' });

      assert.equal(charged.status, 200);
      assert.equal(duplicateCharge.status, 200);
      assert.equal(duplicateCharge.body.attempts, 2);
      assert.equal(lateFailure.status, 409);
      const stored = await RenewalEvent.findById(event._id);
      assert.equal(stored.status, 'charged');
      assert.equal(stored.attempts, 2);
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
    test('caps concurrent gateway requests and prevents duplicate concurrent retries', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      await RenewalEvent.updateMany(
        { billingMonth: '2026-10' },
        { $set: { status: 'failed', failureReason: 'declined' } },
      );
      const extraSubscriptions = await Subscription.insertMany(
        Array.from({ length: 8 }, (_, index) => ({
          name: `Retry customer ${index}`,
          amount: 500,
          currency: 'USD',
          billingCycle: 'monthly',
          status: 'active',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        })),
      );
      await RenewalEvent.insertMany(
        extraSubscriptions.map((subscription) => ({
          subscription: subscription._id,
          billingMonth: '2026-10',
          amount: subscription.amount,
          status: 'failed',
          failureReason: 'declined',
        })),
      );
      const original = paymentGateway.charge;
      let inFlight = 0;
      let maximumInFlight = 0;
      paymentGateway.charge = async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return { ok: false, reason: 'still_declined' };
      };

      try {
        const [first, second] = await Promise.all([
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
          request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' }),
        ]);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(first.body.retried + second.body.retried, 12);
        assert.ok(maximumInFlight <= 4);
        assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-10', attempts: 1 }), 12);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('uses a new idempotency key for each retry attempt', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const figma = await eventFor('Figma', '2026-10');
      await RenewalEvent.updateOne({ _id: figma._id }, { $set: { status: 'failed' } });
      const original = paymentGateway.charge;
      const keys = [];
      paymentGateway.charge = async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        return { ok: false, reason: 'declined' };
      };

      try {
        await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        assert.equal(keys.length, 2);
        assert.notEqual(keys[0], keys[1]);
        assert.equal((await RenewalEvent.findById(figma._id)).attempts, 2);

        const duplicateWebhook = await request(app)
          .patch(`/api/renewals/${figma._id}/status`)
          .send({ status: 'failed', failureReason: 'declined', attemptId: keys[1] });
        assert.equal(duplicateWebhook.status, 200);
        assert.equal(duplicateWebhook.body.attempts, 2);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('reuses the persisted idempotency key when reclaiming an interrupted retry', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const figma = await eventFor('Figma', '2026-10');
      await RenewalEvent.updateOne(
        { _id: figma._id },
        {
          $set: {
            status: 'failed',
            retryToken: 'abandoned-worker',
            retryAttemptId: 'pending-attempt-after-crash',
            retryLockedAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        },
      );
      const original = paymentGateway.charge;
      let receivedKey;
      paymentGateway.charge = async ({ idempotencyKey }) => {
        receivedKey = idempotencyKey;
        return { ok: true, chargeId: 'ch_recovered' };
      };

      try {
        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        assert.equal(res.status, 200);
        assert.equal(res.body.charged, 1);
        assert.ok(receivedKey.endsWith(':pending-attempt-after-crash'));
        const stored = await RenewalEvent.findById(figma._id);
        assert.equal(stored.status, 'charged');
        assert.equal(stored.attempts, 1);
        assert.equal(stored.retryAttemptId, undefined);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('does not resubmit an ambiguous attempt outside the gateway idempotency window', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const figma = await eventFor('Figma', '2026-10');
      await RenewalEvent.updateOne(
        { _id: figma._id },
        {
          $set: {
            status: 'failed',
            retryToken: 'abandoned-worker',
            retryAttemptId: 'expired-provider-key',
            retryAttemptStartedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            retryLockedAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        },
      );
      const original = paymentGateway.charge;
      let called = false;
      paymentGateway.charge = async () => {
        called = true;
        return { ok: true };
      };

      try {
        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        assert.equal(res.status, 200);
        assert.equal(res.body.retried, 0);
        assert.equal(res.body.reconciliationRequired, 1);
        assert.equal(called, false);
        assert.equal((await RenewalEvent.findById(figma._id)).attempts, 0);
      } finally {
        paymentGateway.charge = original;
      }
    });

    test('records gateway transport errors as failed attempts', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const figma = await eventFor('Figma', '2026-10');
      await RenewalEvent.updateOne({ _id: figma._id }, { $set: { status: 'failed' } });
      const original = paymentGateway.charge;
      paymentGateway.charge = async () => {
        const error = new Error('provider rate limited');
        error.status = 429;
        throw error;
      };

      try {
        const res = await request(app).post('/api/renewals/retry-failed').send({ month: '2026-10' });
        assert.equal(res.status, 200);
        assert.equal(res.body.failed, 1);
        const stored = await RenewalEvent.findById(figma._id);
        assert.equal(stored.status, 'failed');
        assert.equal(stored.attempts, 1);
        assert.equal(stored.failureReason, 'provider rate limited');
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
