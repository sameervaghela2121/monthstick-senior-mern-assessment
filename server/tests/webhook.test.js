const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');

const app = createApp();

const patch = (id, body) => request(app).patch(`/api/renewals/${id}/status`).send(body);

async function netflixEvent() {
  const netflix = await Subscription.findOne({ name: 'Netflix' });
  return RenewalEvent.create({ subscription: netflix._id, billingMonth: '2026-10', amount: netflix.amount });
}

describe('PATCH /api/renewals/:id/status (webhooks)', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(async () => {
    await resetDatabase();
    await seedSubscriptions();
  });

  test('10 concurrent failed webhooks record 10 attempts', async () => {
    const event = await netflixEvent();

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => patch(event._id, { status: 'failed', failureReason: `r${i}` })),
    );

    assert.ok(responses.every((res) => res.status === 200));
    const stored = await RenewalEvent.findById(event._id).lean();
    assert.equal(stored.attempts, 10);
    assert.equal(stored.status, 'failed');
  });

  test('concurrent charged and failed webhooks end charged, with one attempt per accepted call', async () => {
    const event = await netflixEvent();
    const bodies = [
      { status: 'failed', failureReason: 'card_declined' },
      { status: 'charged' },
      { status: 'failed' },
      { status: 'charged' },
      { status: 'failed', failureReason: 'insufficient_funds' },
      { status: 'failed' },
    ];

    const responses = await Promise.all(bodies.map((body) => patch(event._id, body)));

    const accepted = responses.filter((res) => res.status === 200).length;
    assert.ok(responses.every((res) => [200, 409].includes(res.status)));
    const stored = await RenewalEvent.findById(event._id).lean();
    assert.equal(stored.status, 'charged');
    assert.ok(stored.chargedAt);
    assert.equal(stored.failureReason, undefined);
    assert.equal(stored.attempts, accepted);
    // Exactly one charged webhook can win; the second is a 409.
    assert.equal(responses.filter((res, i) => bodies[i].status === 'charged' && res.status === 200).length, 1);
  });

  test('a failed webhook after charged is a 409 and leaves the event charged', async () => {
    const event = await netflixEvent();
    await patch(event._id, { status: 'charged' });

    const res = await patch(event._id, { status: 'failed', failureReason: 'late' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, 'Cannot change status from charged to failed');
    const stored = await RenewalEvent.findById(event._id).lean();
    assert.equal(stored.status, 'charged');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.failureReason, undefined);
  });

  test('failed then charged clears the failure reason and returns subscription details', async () => {
    const event = await netflixEvent();
    await patch(event._id, { status: 'failed', failureReason: 'card_declined' });

    const res = await patch(event._id, { status: 'charged' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'charged');
    assert.equal(res.body.attempts, 2);
    assert.equal(res.body.failureReason, null);
    assert.equal(res.body.subscription.name, 'Netflix');
    assert.deepEqual(Object.keys(res.body.subscription).sort(), ['billingCycle', 'id', 'name', 'plan']);
  });

  test('a failed webhook without a reason clears an older reason', async () => {
    const event = await netflixEvent();
    await patch(event._id, { status: 'failed', failureReason: 'card_declined' });
    const res = await patch(event._id, { status: 'failed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.failureReason, null);
  });

  test('an invalid id is a 400 with details', async () => {
    const res = await patch('abc', { status: 'charged' });
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /json/);
    assert.equal(res.body.error.message, 'Invalid request');
    assert.equal(res.body.error.details[0].field, 'id');
  });

  test('an invalid status or reason is a 400', async () => {
    const event = await netflixEvent();
    for (const body of [{ status: 'scheduled' }, { status: 'refunded' }, {}, { status: 'failed', failureReason: 42 }]) {
      const res = await patch(event._id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.error.details.length > 0);
    }
    const stored = await RenewalEvent.findById(event._id).lean();
    assert.equal(stored.attempts, 0);
    assert.equal(stored.status, 'scheduled');
  });

  test('an unknown but valid id is a 404', async () => {
    const res = await patch('0123456789abcdef01234567', { status: 'failed' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, 'Renewal event not found');
  });
});
