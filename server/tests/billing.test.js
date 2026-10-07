// Run tests in UTC, like CI, regardless of the developer's machine.
process.env.TZ = 'UTC';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getMonthRange, isDueInMonth } = require('../src/utils/billing');

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
});

// Billing months are UTC wherever the server runs: east of UTC the local date is already "tomorrow"
// late in the evening, west of UTC it is still "yesterday" just after midnight.
for (const zone of ['Asia/Kolkata', 'America/Los_Angeles']) {
  describe(`billing utils on a server in ${zone}`, () => {
    before(() => {
      process.env.TZ = zone;
    });
    after(() => {
      process.env.TZ = 'UTC';
    });

    const startingAt = (billingCycle, isoDate) => ({ billingCycle, startDate: new Date(isoDate) });

    test('getMonthRange stays on UTC month boundaries', () => {
      const { start, end } = getMonthRange('2026-10');
      assert.equal(start.toISOString(), '2026-10-01T00:00:00.000Z');
      assert.equal(end.toISOString(), '2026-11-01T00:00:00.000Z');
    });

    test('a subscription starting late on 31 October UTC is due in October', () => {
      const canva = startingAt('monthly', '2026-10-31T21:00:00Z');
      assert.equal(isDueInMonth(canva, '2026-09'), false);
      assert.equal(isDueInMonth(canva, '2026-10'), true);
    });

    test('a subscription starting at midnight UTC on 1 November is not due in October', () => {
      const spotify = startingAt('monthly', '2026-11-01T00:00:00Z');
      assert.equal(isDueInMonth(spotify, '2026-10'), false);
      assert.equal(isDueInMonth(spotify, '2026-11'), true);
    });

    test('a yearly subscription keeps its UTC anniversary month', () => {
      const yearly = startingAt('yearly', '2025-10-31T21:00:00Z');
      assert.equal(isDueInMonth(yearly, '2026-10'), true);
      assert.equal(isDueInMonth(yearly, '2026-11'), false);
    });
  });
}
