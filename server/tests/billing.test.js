// Run tests in UTC, like CI, regardless of the developer's machine.
process.env.TZ = 'UTC';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { getMonthRange, isDueInMonth, toMonthKey } = require('../src/utils/billing');

const sub = (billingCycle, startDate) => ({ billingCycle, startDate: new Date(`${startDate}T00:00:00Z`) });

describe('billing utils', () => {
  test('getMonthRange returns the start of the month and the start of the next month', () => {
    const { start, end } = getMonthRange('2026-12');
    assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
  });

  test('monthly subscriptions are due every month from their start month', () => {
    assert.equal(isDueInMonth(sub('monthly', '2026-02-10'), '2026-01'), false);
    assert.equal(isDueInMonth(sub('monthly', '2026-02-10'), '2026-02'), true);
    assert.equal(isDueInMonth(sub('monthly', '2026-02-10'), '2026-10'), true);
  });

  test('yearly subscriptions are due on their anniversary month only', () => {
    assert.equal(isDueInMonth(sub('yearly', '2024-10-03'), '2026-10'), true);
    assert.equal(isDueInMonth(sub('yearly', '2024-10-03'), '2026-11'), false);
    assert.equal(isDueInMonth(sub('yearly', '2026-10-03'), '2025-10'), false);
  });

  test('a start instant late on the last UTC day stays in that UTC month', () => {
    // 2026-10-31 21:00 UTC is 2026-11-01 in Asia/Kolkata. Canva must still be due in October.
    const canva = { billingCycle: 'monthly', startDate: new Date('2026-10-31T21:00:00.000Z') };
    assert.equal(toMonthKey(canva.startDate), '2026-10');
    assert.equal(isDueInMonth(canva, '2026-09'), false);
    assert.equal(isDueInMonth(canva, '2026-10'), true);
    assert.equal(isDueInMonth(canva, '2026-11'), true);

    const { start, end } = getMonthRange('2026-10');
    assert.equal(start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(canva.startDate >= start && canva.startDate < end, true);
  });
});
