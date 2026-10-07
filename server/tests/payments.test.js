const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { paymentGateway, GatewayError, MAX_CONCURRENT_CHARGES } = require('../src/services/paymentGateway');

const app = createApp();
const MONTH = '2026-09';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const webhook = (id, body) => request(app).patch(`/api/renewals/${id}/status`).send(body);
const retryFailed = () => request(app).post('/api/renewals/retry-failed').send({ month: MONTH });

async function createEvents(total, fields = {}) {
  const subscriptions = await Subscription.insertMany(
    Array.from({ length: total }, (_, i) => ({
      name: `Customer ${String(i + 1).padStart(3, '0')}`,
      amount: 1000 + i,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date('2026-01-01T00:00:00Z'),
    })),
  );
  return RenewalEvent.insertMany(
    subscriptions.map((subscription) => ({
      subscription: subscription._id,
      billingMonth: MONTH,
      amount: subscription.amount,
      ...fields,
    })),
  );
}

const createFailedEvents = (total) =>
  createEvents(total, { status: 'failed', attempts: 1, failureReason: 'card_declined' });

describe('Payments', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);
  afterEach(() => mock.restoreAll());

  describe('PATCH /api/renewals/:id/status (webhook)', () => {
    test('concurrent webhooks never lose an attempt', async () => {
      const [event] = await createEvents(1);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => webhook(event._id, { status: 'failed', failureReason: 'card_declined' })),
      );

      assert.ok(responses.every((res) => res.status === 200));
      assert.equal((await RenewalEvent.findById(event._id)).attempts, 10);
      // Every response reports a different attempt number.
      assert.equal(new Set(responses.map((res) => res.body.attempts)).size, 10);
    });

    test('a charge is never overwritten by a failure delivered at the same time', async () => {
      const events = await createEvents(12);

      const results = await Promise.all(
        events.map((event) =>
          Promise.all([
            webhook(event._id, { status: 'failed', failureReason: 'card_declined' }),
            webhook(event._id, { status: 'charged' }),
            webhook(event._id, { status: 'failed', failureReason: 'card_declined' }),
          ]),
        ),
      );

      for (const [index, responses] of results.entries()) {
        const stored = await RenewalEvent.findById(events[index]._id);
        const recorded = responses.filter((res) => res.status === 200).length;

        assert.equal(stored.status, 'charged');
        assert.ok(stored.chargedAt);
        assert.equal(stored.failureReason, undefined);
        assert.equal(stored.attempts, recorded, 'one attempt per accepted webhook');
        assert.ok(responses.every((res) => [200, 409].includes(res.status)));
      }
    });

    test('a repeated charged webhook is refused and does not add an attempt', async () => {
      const [event] = await createEvents(1);

      const first = await webhook(event._id, { status: 'charged' });
      const second = await webhook(event._id, { status: 'charged' });

      assert.equal(first.status, 200);
      assert.equal(second.status, 409);
      assert.match(second.body.error.message, /from charged to charged/);
      assert.equal((await RenewalEvent.findById(event._id)).attempts, 1);
    });

    test('a failed event can later be charged, which clears the failure reason', async () => {
      const [event] = await createFailedEvents(1);

      const res = await webhook(event._id, { status: 'charged' });

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'charged');
      assert.equal(res.body.attempts, 2);
      assert.equal(res.body.failureReason, null);
      assert.equal(res.body.subscription.name, 'Customer 001');
    });
  });

  describe('POST /api/renewals/retry-failed', () => {
    test('responds only after every retry is recorded, with what happened', async () => {
      const events = await createFailedEvents(6);
      const declined = new Set(events.slice(0, 2).map((event) => String(event._id)));
      mock.method(paymentGateway, 'charge', async ({ eventId }) => {
        await sleep(10);
        return declined.has(eventId) ? { ok: false, reason: 'insufficient_funds' } : { ok: true, chargeId: `ch_${eventId}` };
      });

      const res = await retryFailed();

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { month: MONTH, retried: 6, charged: 4, failed: 2 });

      const stored = await RenewalEvent.find({ billingMonth: MONTH });
      for (const event of stored) {
        assert.equal(event.attempts, 2);
        if (declined.has(String(event._id))) {
          assert.equal(event.status, 'failed');
          assert.equal(event.failureReason, 'insufficient_funds');
        } else {
          assert.equal(event.status, 'charged');
          assert.ok(event.chargedAt);
          assert.equal(event.failureReason, undefined);
        }
      }
    });

    test(`never runs more than ${MAX_CONCURRENT_CHARGES} charges at once, even across requests`, async () => {
      await createFailedEvents(20);
      let inFlight = 0;
      let peak = 0;
      mock.method(paymentGateway, 'charge', async ({ eventId }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (inFlight > MAX_CONCURRENT_CHARGES) {
          inFlight -= 1;
          throw new GatewayError('Too many concurrent requests', 429);
        }
        await sleep(15);
        inFlight -= 1;
        return { ok: true, chargeId: `ch_${eventId}` };
      });

      const responses = await Promise.all([retryFailed(), retryFailed()]);

      assert.ok(responses.every((res) => res.status === 200));
      assert.ok(peak <= MAX_CONCURRENT_CHARGES, `peak concurrency was ${peak}`);
      assert.ok(peak > 1, 'retries should still run in parallel');
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: MONTH, status: 'charged' }), 20);
    });

    test('overlapping retry requests charge each event once', async () => {
      const events = await createFailedEvents(8);
      const calls = [];
      mock.method(paymentGateway, 'charge', async (charge) => {
        calls.push(charge);
        await sleep(10);
        return { ok: true, chargeId: `ch_${charge.eventId}` };
      });

      const responses = await Promise.all([retryFailed(), retryFailed(), retryFailed()]);

      assert.ok(responses.every((res) => res.status === 200));
      for (const event of events) {
        const forEvent = calls.filter((charge) => charge.eventId === String(event._id));
        assert.equal(forEvent.length, 1, `event charged ${forEvent.length} times`);
      }
      for (const event of await RenewalEvent.find({ billingMonth: MONTH })) {
        assert.equal(event.status, 'charged');
        assert.equal(event.attempts, 2, 'one recorded attempt per charge');
      }
    });

    test('sends an idempotency key that identifies the event and the attempt', async () => {
      const [event] = await createFailedEvents(1);
      const keys = [];
      mock.method(paymentGateway, 'charge', async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        return { ok: false, reason: 'card_declined' };
      });

      await retryFailed();
      await retryFailed();

      assert.equal(keys.length, 2);
      assert.ok(keys.every((key) => typeof key === 'string' && key.includes(String(event._id))));
      // A new attempt after a recorded decline must be a new charge, not a replay of the old result.
      assert.notEqual(keys[0], keys[1]);
      assert.equal((await RenewalEvent.findById(event._id)).attempts, 3);
    });

    test('a gateway error counts as a failed attempt and does not take the request down', async () => {
      const events = await createFailedEvents(5);
      const broken = String(events[0]._id);
      mock.method(console, 'warn', () => {});
      mock.method(paymentGateway, 'charge', async ({ eventId }) => {
        if (eventId === broken) throw new GatewayError('Too many concurrent requests', 429);
        return { ok: true, chargeId: `ch_${eventId}` };
      });

      const res = await retryFailed();

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { month: MONTH, retried: 5, charged: 4, failed: 1 });
      const stored = await RenewalEvent.findById(broken);
      assert.equal(stored.status, 'failed');
      assert.equal(stored.attempts, 2);
      assert.equal(stored.failureReason, 'gateway_error');
    });

    test('stays within the real gateway limit (no 429s)', async () => {
      await createFailedEvents(16);

      const res = await retryFailed();

      assert.equal(res.status, 200);
      assert.equal(res.body.retried, 16);
      assert.equal(res.body.charged + res.body.failed, 16);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: MONTH, status: 'charged' }), res.body.charged);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: MONTH, failureReason: 'gateway_error' }), 0);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: MONTH, attempts: 2 }), 16);
    });
  });
});
