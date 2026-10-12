const { startDatabase, resetDatabase, stopDatabase } = require('./helpers/db');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp();

function assertBadRequest(res, field) {
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.headers['content-type'], /json/);
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(!JSON.stringify(res.body).includes('    at '), 'response leaks a stack trace');
  if (field) {
    assert.ok(Array.isArray(res.body.error.details));
    assert.equal(res.body.error.details[0].field, field);
    assert.equal(typeof res.body.error.details[0].message, 'string');
  }
}

describe('Input validation', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  describe('month', () => {
    const badMonths = [undefined, '', '2026-13', '2026-00', '2026-1', '26-10', 'abc', '2026-10-01'];

    for (const month of badMonths) {
      test(`GET history rejects month=${JSON.stringify(month)}`, async () => {
        assertBadRequest(await request(app).get('/api/renewals').query(month === undefined ? {} : { month }), 'month');
      });
    }

    test('GET history rejects a repeated month (array)', async () => {
      assertBadRequest(await request(app).get('/api/renewals?month=2026-10&month=2026-11'), 'month');
    });

    test('GET summary rejects a bad month', async () => {
      assertBadRequest(await request(app).get('/api/renewals/summary'), 'month');
      assertBadRequest(await request(app).get('/api/renewals/summary').query({ month: '2026-13' }), 'month');
    });

    for (const path of ['/api/renewals/run', '/api/renewals/retry-failed']) {
      test(`POST ${path} rejects a bad month`, async () => {
        for (const body of [{}, { month: '2026-13' }, { month: 202610 }, { month: ['2026-10'] }]) {
          assertBadRequest(await request(app).post(path).send(body), 'month');
        }
      });

      test(`POST ${path} without a body is a 400`, async () => {
        assertBadRequest(await request(app).post(path), 'month');
      });

      test(`POST ${path} with invalid JSON is a 400`, async () => {
        const res = await request(app).post(path).set('Content-Type', 'application/json').send('{"month": ');
        assertBadRequest(res);
        assert.equal(res.body.error.message, 'Invalid JSON body');
      });
    }
  });

  describe('paging and status filter', () => {
    const cases = [
      ['page', '0'],
      ['page', '-1'],
      ['page', '1.5'],
      ['page', 'abc'],
      ['pageSize', '0'],
      ['pageSize', '201'],
      ['pageSize', 'abc'],
      ['status', 'paid'],
      ['status', 'FAILED'],
    ];
    for (const [field, value] of cases) {
      test(`rejects ${field}=${value}`, async () => {
        const res = await request(app).get('/api/renewals').query({ month: '2026-10', [field]: value });
        assertBadRequest(res, field);
      });
    }

    test('accepts the documented limits', async () => {
      const res = await request(app).get('/api/renewals').query({ month: '2026-10', page: 1, pageSize: 200, status: 'failed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.pageSize, 200);
      assert.equal(res.body.status, 'failed');
    });

    test('defaults page, pageSize and status', async () => {
      const res = await request(app).get('/api/renewals').query({ month: '2026-10' });
      assert.equal(res.body.page, 1);
      assert.equal(res.body.pageSize, 50);
      assert.equal(res.body.status, null);
    });
  });

  describe('webhook', () => {
    test('rejects an invalid id', async () => {
      assertBadRequest(await request(app).patch('/api/renewals/abc/status').send({ status: 'charged' }), 'id');
    });

    test('rejects an invalid JSON body', async () => {
      const res = await request(app)
        .patch('/api/renewals/0123456789abcdef01234567/status')
        .set('Content-Type', 'application/json')
        .send('{not json');
      assertBadRequest(res);
    });

    test('rejects a missing status', async () => {
      const res = await request(app).patch('/api/renewals/0123456789abcdef01234567/status').send({});
      assertBadRequest(res, 'status');
    });
  });
});
