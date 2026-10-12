const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { RenewalEvent } = require('../src/models');
const { taxForAmount, getRevenueSummary } = require('../src/services/revenueSummary');

const MONTH = '2026-10';

function insertEvent(amount, status = 'scheduled', billingMonth = MONTH) {
  // A distinct subscription per event keeps any {subscription, billingMonth} unique index happy.
  return RenewalEvent.create({
    subscription: new mongoose.Types.ObjectId(),
    billingMonth,
    amount,
    status,
  });
}

describe('taxForAmount', () => {
  test('rounds ties to the even cent', () => {
    assert.equal(taxForAmount(25), 4); // 4.50 -> 4
    assert.equal(taxForAmount(75), 14); // 13.50 -> 14
  });

  test('rounds non-ties to the nearest cent', () => {
    assert.equal(taxForAmount(1059), 191); // 190.62
    assert.equal(taxForAmount(2299), 414); // 413.82
    assert.equal(taxForAmount(14400), 2592);
    assert.equal(taxForAmount(1000), 180);
    assert.equal(taxForAmount(0), 0);
  });
});

describe('getRevenueSummary', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  test('totals are sums of per-event values', async () => {
    const amounts = [2299, 14400, 1000, 1059, 25, 75];
    for (const amount of amounts) await insertEvent(amount);
    await insertEvent(99999, 'scheduled', '2026-11'); // other month is ignored

    const summary = await getRevenueSummary(MONTH);

    const subtotal = amounts.reduce((sum, a) => sum + a, 0);
    const tax = amounts.reduce((sum, a) => sum + taxForAmount(a), 0);
    assert.equal(summary.month, MONTH);
    assert.equal(summary.eventCount, amounts.length);
    assert.equal(summary.subtotal, subtotal);
    assert.equal(summary.tax, tax);
    assert.equal(summary.total, subtotal + tax);
    assert.ok(Number.isInteger(summary.tax) && Number.isInteger(summary.total));
  });

  test('per-event rounding differs from rounding the aggregate', async () => {
    for (let i = 0; i < 4; i += 1) await insertEvent(25);

    const summary = await getRevenueSummary(MONTH);

    // Per event: 4.50 -> 4 each, 16 total. Aggregate rounding would give 18 (100 * 0.18).
    assert.equal(summary.tax, 16);
    assert.equal(summary.total, 116);
    assert.notEqual(summary.tax, Math.round(100 * 0.18));
  });

  test('reflects new and updated events on the next call (no stale cache)', async () => {
    const first = await insertEvent(1000);
    const before = await getRevenueSummary(MONTH);
    assert.equal(before.eventCount, 1);
    assert.equal(before.total, 1180);

    await insertEvent(2299);
    await RenewalEvent.updateOne({ _id: first._id }, { status: 'charged' });

    const afterChange = await getRevenueSummary(MONTH);
    assert.equal(afterChange.eventCount, 2);
    assert.equal(afterChange.subtotal, 3299);
    assert.equal(afterChange.tax, 180 + 414);
    assert.deepEqual(afterChange.byStatus, { scheduled: 1, charged: 1, failed: 0 });
  });

  test('counts events by status', async () => {
    await insertEvent(100, 'scheduled');
    await insertEvent(200, 'charged');
    await insertEvent(300, 'charged');
    await insertEvent(400, 'failed');

    const summary = await getRevenueSummary(MONTH);

    assert.deepEqual(summary.byStatus, { scheduled: 1, charged: 2, failed: 1 });
  });

  test('returns zeros for an empty month', async () => {
    const summary = await getRevenueSummary('2030-01');

    assert.deepEqual(summary, {
      month: '2030-01',
      eventCount: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      byStatus: { scheduled: 0, charged: 0, failed: 0 },
    });
  });
});
