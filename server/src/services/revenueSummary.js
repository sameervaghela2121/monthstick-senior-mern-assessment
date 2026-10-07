const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_PERCENT = 18;
const TAX_RATE = TAX_PERCENT / 100;

// GST for one renewal event in cents, rounded to the nearest cent with ties going to the even cent
// (banker's rounding). Integer arithmetic only: 0.18 has no exact binary form, so multiplying by it
// can land a hair above or below a tie and round the wrong way.
function taxForAmount(amount) {
  const hundredths = amount * TAX_PERCENT; // tax in hundredths of a cent
  const cents = Math.floor(hundredths / 100);
  const remainder = hundredths % 100;
  if (remainder > 50) return cents + 1;
  if (remainder === 50) return cents % 2 === 0 ? cents : cents + 1;
  return cents;
}

// Always computed from the database. The previous in-process cache was never invalidated, and it
// could not be invalidated correctly with more than one API instance, so finance saw old totals.
// Grouping in MongoDB keeps this cheap: one indexed read of the month, a handful of rows back.
async function getRevenueSummary(month) {
  const groups = await RenewalEvent.aggregate([
    { $match: { billingMonth: month } },
    { $group: { _id: { status: '$status', amount: '$amount' }, count: { $sum: 1 } } },
  ]);

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let eventCount = 0;
  let subtotal = 0;
  let tax = 0;
  for (const { _id, count } of groups) {
    eventCount += count;
    byStatus[_id.status] = (byStatus[_id.status] ?? 0) + count;
    subtotal += _id.amount * count;
    // Tax depends only on the event's amount, so events with the same amount share one
    // calculation. This is still the sum of per-event tax, never tax on the summed amount.
    tax += taxForAmount(_id.amount) * count;
  }

  return { month, eventCount, subtotal, tax, total: subtotal + tax, byStatus };
}

// There is no cache to clear any more; kept so existing callers keep working.
function clearSummaryCache() {}

module.exports = { TAX_RATE, taxForAmount, getRevenueSummary, clearSummaryCache };
