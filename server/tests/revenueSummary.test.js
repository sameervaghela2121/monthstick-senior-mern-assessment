const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { taxCents } = require('../src/services/revenueSummary');

describe('GST rounding', () => {
  test('rounds each event to the nearest cent and ties to the even cent', () => {
    assert.equal(taxCents(100), 18);
    assert.equal(taxCents(2299), 414);
    assert.equal(taxCents(1059), 191);
    // 25 * 18% = 4.5, and 4 is even.
    assert.equal(taxCents(25), 4);
    // 75 * 18% = 13.5, and 14 is even.
    assert.equal(taxCents(75), 14);
    assert.notEqual(taxCents(25), Math.round(25 * 0.18));
  });
});
