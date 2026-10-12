const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent } = require('../src/models');
const { paymentGateway, GatewayError, MAX_CONCURRENT_CHARGES } = require('../src/services/paymentGateway');

const app = createApp();
const MONTH = '2026-09';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedFailed(count, extra = {}) {
  return RenewalEvent.insertMany(
    Array.from({ length: count }, (_, i) => ({
      subscription: new mongoose.Types.ObjectId(),
      billingMonth: MONTH,
      amount: 1000 + i,
      status: 'failed',
      attempts: 1,
      failureReason: 'card_declined',
      ...extra,
    })),
  );
}

// A stub that behaves like the real gateway: it enforces the concurrency limit with 429s and
// remembers results per idempotency key. `decide(request)` returns the result for a new charge.
function stubGateway(decide = () => ({ ok: true, chargeId: 'ch_test' })) {
  const stats = { inFlight: 0, maxInFlight: 0, calls: [], realCharges: new Map() };
  const byKey = new Map();
  const original = paymentGateway.charge;
  async function perform(req) {
    if (stats.inFlight >= MAX_CONCURRENT_CHARGES) throw new GatewayError('Too many concurrent requests', 429);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await sleep(5 + Math.random() * 10);
      const result = await decide(req);
      if (result.ok) stats.realCharges.set(req.eventId, (stats.realCharges.get(req.eventId) || 0) + 1);
      return result;
    } finally {
      stats.inFlight--;
    }
  }
  paymentGateway.charge = (req) => {
    stats.calls.push(req);
    if (!req.idempotencyKey) return perform(req);
    if (!byKey.has(req.idempotencyKey)) {
      const pending = perform(req);
      byKey.set(req.idempotencyKey, pending);
      pending.catch(() => byKey.delete(req.idempotencyKey));
    }
    return byKey.get(req.idempotencyKey);
  };
  stats.restore = () => {
    paymentGateway.charge = original;
  };
  return stats;
}

const retry = (month = MONTH) => request(app).post('/api/renewals/retry-failed').send({ month });

describe('POST /api/renewals/retry-failed', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  test('never exceeds the gateway limit and responds after every result is recorded', async () => {
    const events = await seedFailed(20);
    const gateway = stubGateway((req) =>
      Number(req.amount) % 2 === 0 ? { ok: true, chargeId: `ch_${req.eventId}` } : { ok: false, reason: 'card_declined' },
    );
    try {
      const res = await retry();

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { month: MONTH, retried: 20, charged: 10, failed: 10, skipped: 0 });
      assert.ok(gateway.maxInFlight <= MAX_CONCURRENT_CHARGES, `max in flight ${gateway.maxInFlight}`);
      assert.equal(gateway.maxInFlight, MAX_CONCURRENT_CHARGES);
      assert.equal(gateway.calls.length, 20);
      for (const call of gateway.calls) assert.match(call.idempotencyKey, /^renewal:[0-9a-f]{24}:attempt:2$/);

      const stored = await RenewalEvent.find({ _id: { $in: events.map((e) => e._id) } }).lean();
      assert.equal(stored.filter((e) => e.status === 'charged').length, 10);
      assert.equal(stored.filter((e) => e.status === 'failed').length, 10);
      assert.ok(stored.every((e) => e.attempts === 2));
      for (const e of stored) {
        if (e.status === 'charged') {
          assert.ok(e.chargedAt);
          assert.equal(e.failureReason, undefined);
        }
      }
    } finally {
      gateway.restore();
    }
  });

  test('gateway errors count as failed attempts without crashing', async () => {
    await seedFailed(8);
    let n = 0;
    const gateway = stubGateway(() => {
      n += 1;
      if (n % 2 === 0) throw new GatewayError('Too many concurrent requests', 429);
      return { ok: true, chargeId: 'ch_ok' };
    });
    try {
      const res = await retry();

      assert.equal(res.status, 200);
      assert.equal(res.body.retried, 8);
      assert.equal(res.body.charged, 4);
      assert.equal(res.body.failed, 4);
      const stillFailed = await RenewalEvent.find({ billingMonth: MONTH, status: 'failed' }).lean();
      assert.equal(stillFailed.length, 4);
      assert.ok(stillFailed.every((e) => e.attempts === 2 && e.failureReason === 'gateway_error_429'));
    } finally {
      gateway.restore();
    }
  });

  test('a gateway error without a status is recorded as gateway_error', async () => {
    await seedFailed(1);
    const gateway = stubGateway(() => {
      throw new Error('socket hang up');
    });
    try {
      const res = await retry();
      assert.equal(res.status, 200);
      assert.equal(res.body.failed, 1);
      const [event] = await RenewalEvent.find().lean();
      assert.equal(event.failureReason, 'gateway_error');
      assert.equal(event.attempts, 2);
    } finally {
      gateway.restore();
    }
  });

  test('two concurrent retries charge each event once and record one attempt each', async () => {
    const events = await seedFailed(10);
    const gateway = stubGateway((req) => ({ ok: true, chargeId: `ch_${req.eventId}` }));
    try {
      const [a, b] = await Promise.all([retry(), retry()]);

      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(a.body.charged + b.body.charged, 10);
      for (const event of events) assert.equal(gateway.realCharges.get(String(event._id)), 1);
      const stored = await RenewalEvent.find().lean();
      assert.ok(stored.every((e) => e.status === 'charged' && e.attempts === 2));
    } finally {
      gateway.restore();
    }
  });

  test('a retry after a completed retry does not charge already charged events again', async () => {
    await seedFailed(3);
    const gateway = stubGateway();
    try {
      await retry();
      const second = await retry();
      assert.deepEqual(second.body, { month: MONTH, retried: 0, charged: 0, failed: 0, skipped: 0 });
      assert.equal(gateway.calls.length, 3);
    } finally {
      gateway.restore();
    }
  });

  test('only retries failed events of the requested month', async () => {
    await seedFailed(2);
    await seedFailed(2, { billingMonth: '2026-08' });
    await RenewalEvent.create({ subscription: new mongoose.Types.ObjectId(), billingMonth: MONTH, amount: 1 });
    const gateway = stubGateway();
    try {
      const res = await retry();
      assert.equal(res.body.retried, 2);
      assert.equal(await RenewalEvent.countDocuments({ billingMonth: '2026-08', status: 'failed' }), 2);
    } finally {
      gateway.restore();
    }
  });
});
