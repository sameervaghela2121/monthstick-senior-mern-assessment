const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent, Subscription } = require('../src/models');
const { seedDatabase, seedSubscriptions } = require('../scripts/seedData');
const { clearSummaryCache } = require('../src/services/revenueSummary');

const app = createApp();

describe('Renewals API - New Features and Fixes', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(async () => {
    await resetDatabase();
    clearSummaryCache();
    await seedSubscriptions();
  });

  describe('Duplicate Prevention (Issue #1)', () => {
    test('running renewals twice for the same month creates events only once', async () => {
      // First run
      const res1 = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      assert.equal(res1.status, 201);
      assert.equal(res1.body.createdCount, 4);
      assert.equal(res1.body.existingCount, 0);

      // Second run (should not create duplicates)
      const res2 = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      assert.equal(res2.status, 200);
      assert.equal(res2.body.createdCount, 0);
      assert.equal(res2.body.existingCount, 4);

      // Verify total count is still 4
      const count = await RenewalEvent.countDocuments({ billingMonth: '2026-10' });
      assert.equal(count, 4);
    });

    test('concurrent requests cannot create duplicate events', async () => {
      // Simulate concurrent requests
      const promises = Array(3)
        .fill(null)
        .map(() => request(app).post('/api/renewals/run').send({ month: '2026-10' }));

      const results = await Promise.all(promises);

      // Only one should have created events, others should see existing
      const totalCreated = results.reduce((sum, res) => sum + (res.body.createdCount || 0), 0);
      const totalExisting = results.reduce((sum, res) => sum + (res.body.existingCount || 0), 0);

      assert.equal(totalCreated + totalExisting, 12); // 4 events × 3 requests
      const actualCount = await RenewalEvent.countDocuments({ billingMonth: '2026-10' });
      assert.equal(actualCount, 4); // Should still be just 4
    });

    test('created and existing arrays contain event IDs', async () => {
      // First run
      const res1 = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      assert.ok(Array.isArray(res1.body.created));
      assert.ok(Array.isArray(res1.body.existing));
      assert.equal(res1.body.created.length, 4);

      // Second run
      const res2 = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      assert.ok(Array.isArray(res2.body.created));
      assert.ok(Array.isArray(res2.body.existing));
      assert.equal(res2.body.existing.length, 4);
      assert.deepEqual(res2.body.existing, res1.body.created);
    });
  });

  describe('Status Filter (Issue #5)', () => {
    test('GET /renewals accepts optional status parameter', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      // Get all events
      const allRes = await request(app).get('/api/renewals').query({ month: '2026-10' });
      assert.equal(allRes.body.count, 4);
      assert.equal(allRes.body.status, null);

      // Filter by scheduled
      const scheduledRes = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'scheduled' });
      assert.equal(scheduledRes.body.count, 4);
      assert.equal(scheduledRes.body.status, 'scheduled');

      // Filter by charged (should be empty)
      const chargedRes = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'charged' });
      assert.equal(chargedRes.body.count, 0);
      assert.equal(chargedRes.body.events.length, 0);
    });

    test('status filter correctly reflects pagination', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      // Change some to charged
      const events = await RenewalEvent.find({ billingMonth: '2026-10' }).limit(2);
      for (const event of events) {
        event.status = 'charged';
        await event.save();
      }

      // Filter by charged with pagination
      const chargedRes = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'charged', page: 1, pageSize: 1 });
      assert.equal(chargedRes.body.count, 2);
      assert.equal(chargedRes.body.totalPages, 2);
      assert.equal(chargedRes.body.events.length, 1);
    });

    test('invalid status parameter returns 400', async () => {
      const res = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'invalid' });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.message.includes('status'));
    });
  });

  describe('Input Validation (Issue #4)', () => {
    test('invalid month format returns 400', async () => {
      const res = await request(app).post('/api/renewals/run').send({ month: 'invalid' });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.message.includes('month format'));
    });

    test('invalid page number returns 400', async () => {
      const res = await request(app).get('/api/renewals').query({ month: '2026-10', page: 0 });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.message.includes('page'));
    });

    test('pageSize exceeding maximum returns 400', async () => {
      const res = await request(app).get('/api/renewals').query({ month: '2026-10', pageSize: 201 });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.message.includes('pageSize'));
    });

    test('invalid event ID returns 400 on PATCH', async () => {
      const res = await request(app)
        .patch('/api/renewals/invalid-id/status')
        .send({ status: 'charged' });
      assert.equal(res.status, 400);
    });

    test('invalid status on PATCH returns 400', async () => {
      const event = await RenewalEvent.create({
        subscription: (await Subscription.findOne())._id,
        billingMonth: '2026-10',
        amount: 1000,
      });
      const res = await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'invalid' });
      assert.equal(res.status, 400);
    });
  });

  describe('Pagination Correctness (Issue #6c)', () => {
    test('totalPages calculation uses ceiling division', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      const res1 = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', pageSize: 1 });
      assert.equal(res1.body.count, 4);
      assert.equal(res1.body.totalPages, 4); // ceil(4/1)

      const res2 = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', pageSize: 3 });
      assert.equal(res2.body.count, 4);
      assert.equal(res2.body.totalPages, 2); // ceil(4/3)
    });

    test('all events returned across all pages without duplicates', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      const pageSize = 1;
      const res = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', pageSize });

      const allIds = new Set();
      for (let page = 1; page <= res.body.totalPages; page++) {
        const pageRes = await request(app)
          .get('/api/renewals')
          .query({ month: '2026-10', page, pageSize });
        pageRes.body.events.forEach((e) => allIds.add(e.id));
      }

      assert.equal(allIds.size, 4);
    });
  });

  describe('Revenue Summary Caching (Issue #6a)', () => {
    test('cache is cleared when events are created', async () => {
      // Get summary (should populate cache)
      const res1 = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      const count1 = res1.body.eventCount;

      // Create more events
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      // Get summary again (should show new count, not cached)
      const res2 = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      const count2 = res2.body.eventCount;

      assert.notEqual(count1, count2);
    });

    test('cache is cleared when event status changes', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const res1 = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.equal(res1.body.byStatus.scheduled, 4);

      // Update an event status
      const event = await RenewalEvent.findOne({ billingMonth: '2026-10' });
      await request(app)
        .patch(`/api/renewals/${event._id}/status`)
        .send({ status: 'charged' });

      // Get summary again (should show updated counts)
      const res2 = await request(app).get('/api/renewals/summary').query({ month: '2026-10' });
      assert.equal(res2.body.byStatus.scheduled, 3);
      assert.equal(res2.body.byStatus.charged, 1);
    });
  });

  describe('Timezone Handling (Issue #6b)', () => {
    test('UTC timezone is used for month ranges', async () => {
      // Canva starts at 2026-10-31T21:00:00Z (9 PM UTC on Oct 31)
      // Should be included in October, not November
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });

      // Find all October events and look for Canva
      const allOctoberEvents = await RenewalEvent.find({
        billingMonth: '2026-10',
      })
        .populate('subscription')
        .lean();

      assert.ok(allOctoberEvents.length > 0, 'Should have events for October');
      
      const canvaEvent = allOctoberEvents.find((e) => e.subscription.name === 'Canva');
      assert.ok(canvaEvent, 'Canva should be included in October (UTC timezone handling)');
    });
  });

  describe('API Response Structure', () => {
    test('POST /renewals/run returns proper structure', async () => {
      const res = await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      assert.ok(res.body.month);
      assert.ok(typeof res.body.dueCount === 'number');
      assert.ok(typeof res.body.createdCount === 'number');
      assert.ok(typeof res.body.existingCount === 'number');
      assert.ok(Array.isArray(res.body.created));
      assert.ok(Array.isArray(res.body.existing));
    });

    test('GET /renewals returns status field', async () => {
      await request(app).post('/api/renewals/run').send({ month: '2026-10' });
      const res = await request(app)
        .get('/api/renewals')
        .query({ month: '2026-10', status: 'scheduled' });
      assert.equal(res.body.status, 'scheduled');
    });
  });
});
