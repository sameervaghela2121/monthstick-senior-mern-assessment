const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_RATE = 0.18;

// Banker's rounding: rounds to nearest even number on ties
function bankersRound(value) {
  const rounded = Math.round(value);
  // Check if we're at a tie (exactly .5)
  if (Math.abs(value - rounded) === 0.5) {
    // Round to the nearest even number
    return rounded % 2 === 0 ? rounded : rounded - Math.sign(value - rounded);
  }
  return rounded;
}

// Summaries are expensive to build for large months, so they are cached per month.
const cache = new Map();

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let totalTax = 0;

  for (const event of events) {
    subtotal += event.amount;
    // Calculate tax per event using banker's rounding, then sum
    const eventTax = bankersRound(event.amount * TAX_RATE);
    totalTax += eventTax;
    byStatus[event.status] += 1;
  }

  const summary = {
    month,
    eventCount: events.length,
    subtotal,
    tax: totalTax,
    total: subtotal + totalTax,
    byStatus,
  };

  cache.set(month, summary);
  return summary;
}

function clearSummaryCache() {
  cache.clear();
}

module.exports = { TAX_RATE, getRevenueSummary, clearSummaryCache };
