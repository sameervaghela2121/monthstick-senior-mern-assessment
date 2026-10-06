const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { getMonthRange, isDueInMonth } = require('../src/utils/billing');

const sub = (billingCycle, startDate) => ({ billingCycle, startDate: new Date(`${startDate}T00:00:00Z`) });

describe('billing utils', () => {
  test('getMonthRange returns the UTC start of the month and the start of the next month', () => {
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
});
