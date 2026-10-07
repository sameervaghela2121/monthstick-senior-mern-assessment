const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_RATE = 0.18;

// Summaries are expensive to build for large months, so they are cached per month.
const cache = new Map();

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  for (const event of events) {
    subtotal += event.amount / 100;
    byStatus[event.status] += 1;
  }
  const tax = subtotal * TAX_RATE;

  const summary = {
    month,
    eventCount: events.length,
    subtotal: Math.round(subtotal * 100),
    tax: Math.round(tax * 100),
    total: Math.round((subtotal + tax) * 100),
    byStatus,
  };

  cache.set(month, summary);
  return summary;
}

function clearSummaryCache() {
  cache.clear();
}

module.exports = { TAX_RATE, getRevenueSummary, clearSummaryCache };
