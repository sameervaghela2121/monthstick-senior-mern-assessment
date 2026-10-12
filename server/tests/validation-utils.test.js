const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  HttpError,
  badRequest,
  parseMonth,
  parsePage,
  parsePageSize,
  parseStatusFilter,
  parseObjectId,
  parseWebhookBody,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} = require('../src/utils/validation');

function assertBadRequest(fn, field) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.equal(err.details[0].field, field);
    assert.equal(typeof err.details[0].message, 'string');
    return true;
  });
}

describe('validation utils', () => {
  test('badRequest builds a 400 HttpError with optional details', () => {
    const err = badRequest('Nope');
    assert.ok(err instanceof Error);
    assert.equal(err.status, 400);
    assert.equal(err.message, 'Nope');
    assert.equal(err.details, undefined);
    assert.deepEqual(badRequest('Nope', [{ field: 'x', message: 'y' }]).details, [{ field: 'x', message: 'y' }]);
  });

  test('parseMonth accepts YYYY-MM and rejects everything else', () => {
    assert.equal(parseMonth('2026-10'), '2026-10');
    assert.equal(parseMonth('2026-01'), '2026-01');
    for (const value of [undefined, '', '2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', ' 2026-10', ['2026-10', '2026-11'], 202610]) {
      assertBadRequest(() => parseMonth(value), 'month');
    }
    assertBadRequest(() => parseMonth('bad', 'from'), 'from');
  });

  test('parsePage defaults to 1 and requires a positive integer', () => {
    assert.equal(parsePage(undefined), 1);
    assert.equal(parsePage(''), 1);
    assert.equal(parsePage('3'), 3);
    assert.equal(parsePage(2), 2);
    for (const value of ['0', '-1', '1.5', 'abc', '1e3', ' 1', ['1', '2'], 1.5, 0, '99999999999999999999']) {
      assertBadRequest(() => parsePage(value), 'page');
    }
  });

  test('parsePageSize defaults to 50 and is capped at 200', () => {
    assert.equal(DEFAULT_PAGE_SIZE, 50);
    assert.equal(MAX_PAGE_SIZE, 200);
    assert.equal(parsePageSize(undefined), 50);
    assert.equal(parsePageSize(''), 50);
    assert.equal(parsePageSize('1'), 1);
    assert.equal(parsePageSize('200'), 200);
    for (const value of ['0', '201', '-5', '10.5', 'all', ['10']]) {
      assertBadRequest(() => parsePageSize(value), 'pageSize');
    }
  });

  test('parseStatusFilter allows empty or a known status', () => {
    assert.equal(parseStatusFilter(undefined), null);
    assert.equal(parseStatusFilter(''), null);
    for (const status of ['scheduled', 'charged', 'failed']) assert.equal(parseStatusFilter(status), status);
    for (const value of ['FAILED', 'paid', ['failed'], { $ne: 'x' }]) {
      assertBadRequest(() => parseStatusFilter(value), 'status');
    }
  });

  test('parseObjectId requires 24 hex characters', () => {
    assert.equal(parseObjectId('65a1b2c3d4e5f60718293a4b'), '65a1b2c3d4e5f60718293a4b');
    for (const value of ['abc', '65a1b2c3d4e5f60718293a4z', '65a1b2c3d4e5f60718293a4b0', undefined, ['65a1b2c3d4e5f60718293a4b']]) {
      assertBadRequest(() => parseObjectId(value), 'id');
    }
  });

  test('parseWebhookBody validates status and failureReason', () => {
    assert.deepEqual(parseWebhookBody({ status: 'charged' }), { status: 'charged', failureReason: undefined });
    assert.deepEqual(parseWebhookBody({ status: 'failed', failureReason: 'card_declined' }), {
      status: 'failed',
      failureReason: 'card_declined',
    });
    assert.equal(parseWebhookBody({ status: 'failed', failureReason: 'x'.repeat(500) }).failureReason.length, 500);

    for (const body of [undefined, null, 'charged', ['charged']]) {
      assertBadRequest(() => parseWebhookBody(body), 'body');
    }
    for (const body of [{}, { status: 'scheduled' }, { status: 'CHARGED' }, { status: ['charged'] }]) {
      assertBadRequest(() => parseWebhookBody(body), 'status');
    }
    for (const failureReason of [42, { a: 1 }, 'x'.repeat(501)]) {
      assertBadRequest(() => parseWebhookBody({ status: 'failed', failureReason }), 'failureReason');
    }
  });
});
