const { RenewalEvent } = require('../models');

// GST applied to every renewal. TAX_RATE is kept for compatibility; all money
// maths uses the integer percentage so no floating point touches cents.
const TAX_RATE = 0.18;
const TAX_RATE_PERCENT = 18;

/**
 * GST for one renewal event, in integer cents.
 * Rounded to the nearest cent with ties to the even cent (banker's rounding).
 */
function taxForAmount(cents) {
  const x = cents * TAX_RATE_PERCENT;
  const q = Math.floor(x / 100);
  const r = x % 100;
  if (r > 50 || (r === 50 && q % 2 === 1)) return q + 1;
  return q;
}

/**
 * Revenue summary for a billing month (YYYY-MM), in integer cents.
 * Tax is calculated per event and summed; totals are sums of per-event values.
 * Not cached: finance figures must reflect runs and webhooks immediately.
 */
async function getRevenueSummary(month) {
  const events = await RenewalEvent.find({ billingMonth: month }, { amount: 1, status: 1 }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  for (const event of events) {
    subtotal += event.amount;
    tax += taxForAmount(event.amount);
    byStatus[event.status] += 1;
  }

  return {
    month,
    eventCount: events.length,
    subtotal,
    tax,
    total: subtotal + tax,
    byStatus,
  };
}

module.exports = { TAX_RATE, TAX_RATE_PERCENT, taxForAmount, getRevenueSummary };
