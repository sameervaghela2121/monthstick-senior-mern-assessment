const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_RATE = 0.18;

// Summaries are expensive to build for large months, so they are cached per month.
const cache = new Map();

function bankerRound(value) {
  const abs = Math.abs(value);
  const integer = Math.floor(abs);
  const fraction = abs - integer;

  if (fraction < 0.5) return Math.sign(value) * integer;
  if (fraction > 0.5) return Math.sign(value) * (integer + 1);

  const nearestEven = integer % 2 === 0 ? integer : integer + 1;
  return Math.sign(value) * nearestEven;
}

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  for (const event of events) {
    subtotal += event.amount;
    byStatus[event.status] += 1;
    tax += bankerRound(event.amount * TAX_RATE);
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

function clearSummaryCache() {
  cache.clear();
}

module.exports = { TAX_RATE, getRevenueSummary, clearSummaryCache };
