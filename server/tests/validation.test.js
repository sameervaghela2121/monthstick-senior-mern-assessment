const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { RenewalEvent } = require('../src/models');
const { seedSubscriptions } = require('../scripts/seedData');

const app = createApp();
const VALID_ID = '0123456789abcdef01234567';

function assertBadRequest(res, field) {
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(Array.isArray(res.body.error.details) && res.body.error.details.length > 0);
  assert.ok(
    res.body.error.details.some((detail) => detail.field === field && typeof detail.message === 'string'),
    `no detail for "${field}" in ${JSON.stringify(res.body)}`,
  );
  // Nothing internal leaks: no stack frames, driver or ODM error names.
  assert.doesNotMatch(JSON.stringify(res.body), /\bat \S+ \(|node_modules|CastError|ObjectId|Mongo|BSON/);
}

describe('Request validation', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(async () => {
    await resetDatabase();
    await seedSubscriptions();
  });

  describe('month', () => {
    const badMonths = [undefined, '', '2026', '2026-1', '2026-00', '2026-13', '10-2026', '2026-10-01', ' 2026-10', 202610, null, ['2026-10'], { $ne: null }];

    for (const month of badMonths) {
      const label = JSON.stringify(month) ?? 'missing';

      test(`POST /run rejects month ${label}`, async () => {
        assertBadRequest(await request(app).post('/api/renewals/run').send({ month }), 'month');
        assert.equal(await RenewalEvent.countDocuments(), 0);
      });

      test(`POST /retry-failed rejects month ${label}`, async () => {
        assertBadRequest(await request(app).post('/api/renewals/retry-failed').send({ month }), 'month');
      });
    }

    for (const query of [{}, { month: '2026-13' }, { month: '2026-1' }, { month: 'october' }, { 'month[$ne]': 'x' }, { month: ['2026-10', '2026-11'] }]) {
      test(`GET /renewals and /summary reject ${JSON.stringify(query)}`, async () => {
        assertBadRequest(await request(app).get('/api/renewals').query(query), 'month');
        assertBadRequest(await request(app).get('/api/renewals/summary').query(query), 'month');
      });
    }
  });

  describe('page and pageSize', () => {
    for (const [field, value] of [
      ['page', '0'],
      ['page', '-1'],
      ['page', '1.5'],
      ['page', 'abc'],
      ['page', '1e3'],
      ['page', ''],
      ['pageSize', '0'],
      ['pageSize', '-5'],
      ['pageSize', '201'],
      ['pageSize', '10.5'],
      ['pageSize', 'all'],
    ]) {
      test(`GET /renewals rejects ${field}=${JSON.stringify(value)}`, async () => {
        assertBadRequest(await request(app).get('/api/renewals').query({ month: '2026-10', [field]: value }), field);
      });
    }

    test('reports every invalid field at once', async () => {
      const res = await request(app).get('/api/renewals').query({ month: 'nope', page: '0', pageSize: '999', status: 'x' });

      assert.equal(res.status, 400);
      assert.deepEqual(res.body.error.details.map((detail) => detail.field).sort(), ['month', 'page', 'pageSize', 'status']);
    });

    test('accepts the largest allowed page size and the defaults', async () => {
      const largest = await request(app).get('/api/renewals').query({ month: '2026-10', page: '1', pageSize: '200' });
      assert.equal(largest.status, 200);
      assert.equal(largest.body.pageSize, 200);

      const defaults = await request(app).get('/api/renewals').query({ month: '2026-10' });
      assert.equal(defaults.status, 200);
      assert.equal(defaults.body.page, 1);
      assert.equal(defaults.body.pageSize, 50);
    });
  });

  describe('PATCH /:id/status', () => {
    for (const id of ['not-an-id', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '0123456789abcdef0123456']) {
      test(`rejects event id ${id}`, async () => {
        assertBadRequest(await request(app).patch(`/api/renewals/${id}/status`).send({ status: 'charged' }), 'id');
      });
    }

    for (const status of [undefined, '', 'scheduled', 'refunded', 'CHARGED', 1, null, ['charged'], { $ne: 'x' }]) {
      test(`rejects status ${JSON.stringify(status) ?? 'missing'}`, async () => {
        assertBadRequest(await request(app).patch(`/api/renewals/${VALID_ID}/status`).send({ status }), 'status');
      });
    }

    for (const failureReason of [42, { reason: 'x' }, ['card_declined'], 'x'.repeat(201)]) {
      test(`rejects failureReason ${JSON.stringify(failureReason).slice(0, 30)}`, async () => {
        const res = await request(app).patch(`/api/renewals/${VALID_ID}/status`).send({ status: 'failed', failureReason });
        assertBadRequest(res, 'failureReason');
      });
    }

    test('a well-formed id that does not exist is still a 404', async () => {
      const res = await request(app).patch(`/api/renewals/${VALID_ID}/status`).send({ status: 'charged' });
      assert.equal(res.status, 404);
    });
  });

  test('a malformed JSON body gets a clean 400', async () => {
    const res = await request(app)
      .post('/api/renewals/run')
      .set('Content-Type', 'application/json')
      .send('{"month": "2026-10"');

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: { message: 'Request body must be valid JSON' } });
  });

  test('a non-object JSON body is rejected', async () => {
    assertBadRequest(await request(app).post('/api/renewals/run').send(['2026-10']), 'month');
  });
});
