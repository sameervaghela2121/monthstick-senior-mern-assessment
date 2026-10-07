const { RenewalEvent } = require('../models');

// GST applied to every renewal. Calculated per event, in integer cents.
const TAX_RATE = 0.18;
const TAX_NUMERATOR = 18;
const TAX_DENOMINATOR = 100;

// Summaries are expensive to build for large months, so they are cached per month.
// Callers must invalidate a month after any write that changes its events.
const cache = new Map();

// Round a positive integer ratio to the nearest integer, with exact halves
// toward the even integer (banker's rounding).
function roundHalfToEven(numerator, denominator) {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  if (remainder * 2 < denominator) return quotient;
  if (remainder * 2 > denominator) return quotient + 1;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

function taxCents(amountCents) {
  return roundHalfToEven(amountCents * TAX_NUMERATOR, TAX_DENOMINATOR);
}

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  for (const event of events) {
    subtotal += event.amount;
    tax += taxCents(event.amount);
    byStatus[event.status] += 1;
  }

  const summary = {
    month,
    eventCount: events.length,
    subtotal,
    tax,
    total: subtotal + tax,
    byStatus,
  };

  cache.set(month, summary);
  return summary;
}

function invalidateRevenueSummary(month) {
  cache.delete(month);
}

function clearSummaryCache() {
  cache.clear();
}

module.exports = {
  TAX_RATE,
  taxCents,
  getRevenueSummary,
  invalidateRevenueSummary,
  clearSummaryCache,
};
