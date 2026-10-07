const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');

const app = createApp();

const summary = (month) => request(app).get('/api/renewals/summary').query({ month });

async function createEventsWithAmounts(month, amounts) {
  const subscriptions = await Subscription.insertMany(
    amounts.map((amount, i) => ({
      name: `Customer ${i + 1}`,
      amount,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date('2026-01-01T00:00:00Z'),
    })),
  );
  await RenewalEvent.insertMany(
    subscriptions.map((subscription) => ({ subscription: subscription._id, billingMonth: month, amount: subscription.amount })),
  );
}

describe('GET /api/renewals/summary', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  test('October totals equal the sum of the per-event invoices', async () => {
    await seedSubscriptions();
    await request(app).post('/api/renewals/run').send({ month: '2026-10' });

    const res = await summary('2026-10');

    // GST per event: Netflix 2299 -> 414, Figma 14400 -> 2592, GitHub Copilot 1000 -> 180, Canva 1059 -> 191.
    assert.equal(res.body.subtotal, 18758);
    assert.equal(res.body.tax, 414 + 2592 + 180 + 191);
    assert.equal(res.body.total, 18758 + 3377);
  });

  test('GST ties are rounded to the even cent, per event', async () => {
    // 18% of 25 = 4.5 -> 4, of 75 = 13.5 -> 14, of 125 = 22.5 -> 22, of 175 = 31.5 -> 32.
    await createEventsWithAmounts('2026-07', [25, 75, 125, 175]);

    const res = await summary('2026-07');

    assert.equal(res.body.eventCount, 4);
    assert.equal(res.body.subtotal, 400);
    assert.equal(res.body.tax, 4 + 14 + 22 + 32);
    assert.equal(res.body.total, 472);
    assert.ok(Number.isInteger(res.body.tax) && Number.isInteger(res.body.total));
  });

  test('many events with the same amount are still taxed one by one', async () => {
    // Each 25-cent event owes 4 cents (4.5 rounded to even); 10 x 25 taxed as one sum would be 45.
    await createEventsWithAmounts('2026-07', Array(10).fill(25));

    const res = await summary('2026-07');

    assert.equal(res.body.tax, 40);
    assert.equal(res.body.total, 290);
  });

  test('reflects new renewals and payments straight away', async () => {
    await seedSubscriptions();

    const empty = await summary('2026-10');
    assert.equal(empty.body.eventCount, 0);
    assert.equal(empty.body.total, 0);

    await request(app).post('/api/renewals/run').send({ month: '2026-10' });
    const afterRun = await summary('2026-10');
    assert.equal(afterRun.body.eventCount, 4);
    assert.deepEqual(afterRun.body.byStatus, { scheduled: 4, charged: 0, failed: 0 });

    const event = await RenewalEvent.findOne({ billingMonth: '2026-10' });
    await request(app).patch(`/api/renewals/${event._id}/status`).send({ status: 'charged' });
    const afterPayment = await summary('2026-10');
    assert.deepEqual(afterPayment.body.byStatus, { scheduled: 3, charged: 1, failed: 0 });
  });
});
