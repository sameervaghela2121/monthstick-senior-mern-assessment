const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedDatabase } = require('../scripts/seedData');
const { dedupeRenewalEvents } = require('../scripts/dedupeRenewals');

const UNIQUE_INDEX = 'subscription_1_billingMonth_1';
const archive = () => mongoose.connection.collection('renewalevents_duplicates');
const silent = () => {};

describe('dedupeRenewalEvents', () => {
  before(startDatabase);
  after(async () => {
    await RenewalEvent.syncIndexes();
    await stopDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    await archive().deleteMany({});
    // The production snapshot predates the unique index, so seed it without the index in place.
    const indexes = await RenewalEvent.collection.indexes();
    if (indexes.some((index) => index.name === UNIQUE_INDEX)) {
      await RenewalEvent.collection.dropIndex(UNIQUE_INDEX);
    }
    await seedDatabase();
  });

  test('keeps one event per subscription and month, preferring the earliest charge', async () => {
    const netflix = await Subscription.findOne({ name: 'Netflix' });
    assert.equal(await RenewalEvent.countDocuments({ subscription: netflix._id }), 4);

    const result = await dedupeRenewalEvents({ log: silent });

    assert.equal(result.groups, 2);
    assert.equal(result.removed, 2);
    assert.equal(result.chargedDuplicates.length, 2);

    const remaining = await RenewalEvent.find({ subscription: netflix._id }).sort({ billingMonth: 1 }).lean();
    assert.deepEqual(remaining.map((e) => e.billingMonth), ['2026-08', '2026-09']);
    assert.equal(remaining[1].status, 'charged');
    assert.equal(remaining[1].chargedAt.toISOString(), '2026-09-15T09:00:00.000Z');

    const archived = await archive().find({}).toArray();
    assert.equal(archived.length, 2);
    const keptIds = remaining.map((e) => String(e._id)).sort();
    assert.deepEqual(archived.map((e) => String(e.keptId)).sort(), keptIds);
    assert.ok(archived.every((e) => e.archivedAt instanceof Date));

    // Events that were not duplicated are untouched.
    assert.equal(await RenewalEvent.countDocuments(), 4);
  });

  test('prefers the event with most attempts, then the oldest, when none is charged', async () => {
    const figma = await Subscription.findOne({ name: 'Figma' });
    const base = { subscription: figma._id, billingMonth: '2026-10', amount: 14400, status: 'failed' };
    const [, , mostAttempts] = await RenewalEvent.insertMany([
      { ...base, attempts: 1 },
      { ...base, attempts: 1 },
      { ...base, attempts: 3 },
    ]);
    await RenewalEvent.insertMany([
      { ...base, billingMonth: '2026-11', status: 'scheduled', attempts: 0, createdAt: new Date('2026-10-02T00:00:00Z') },
      { ...base, billingMonth: '2026-11', status: 'scheduled', attempts: 0, createdAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    const oldest = await RenewalEvent.findOne({ subscription: figma._id, billingMonth: '2026-11' }).sort({ createdAt: 1 });

    await dedupeRenewalEvents({ log: silent });

    const october = await RenewalEvent.find({ subscription: figma._id, billingMonth: '2026-10' }).lean();
    assert.deepEqual(october.map((e) => String(e._id)), [String(mostAttempts._id)]);
    const november = await RenewalEvent.find({ subscription: figma._id, billingMonth: '2026-11' }).lean();
    assert.deepEqual(november.map((e) => String(e._id)), [String(oldest._id)]);
  });

  test('is idempotent and lets the unique index build', async () => {
    await assert.rejects(RenewalEvent.syncIndexes(), /duplicate key/i);

    await dedupeRenewalEvents({ log: silent });
    const second = await dedupeRenewalEvents({ log: silent });

    assert.deepEqual(second, { groups: 0, removed: 0, chargedDuplicates: [] });
    assert.equal(await archive().countDocuments(), 2);

    await RenewalEvent.syncIndexes();
    const indexes = await RenewalEvent.collection.indexes();
    assert.ok(indexes.some((index) => index.name === UNIQUE_INDEX && index.unique));
  });

  test('logs charged duplicates as possible double charges', async () => {
    const lines = [];
    await dedupeRenewalEvents({ log: (line) => lines.push(line) });
    assert.match(lines.join('\n'), /possible double charges/);
  });
});
