const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_RATE = 0.18;

// Summaries are expensive to build for large months, so they are cached per month.
const cache = new Map();

/**
 * Banker's Rounding (Round half to even) for minor currency units (cents).
 */
function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  let total = 0;

  for (const event of events) {
    const eventAmount = event.amount;
    const eventTax = roundHalfToEven(eventAmount * TAX_RATE);
    const eventTotal = eventAmount + eventTax;

    subtotal += eventAmount;
    tax += eventTax;
    total += eventTotal;
    if (byStatus[event.status] !== undefined) {
      byStatus[event.status] += 1;
    }
  }

  const summary = {
    month,
    eventCount: events.length,
    subtotal,
    tax,
    total,
    byStatus,
  };

  cache.set(month, summary);
  return summary;
}

function clearSummaryCache(month) {
  if (month) {
    cache.delete(month);
  } else {
    cache.clear();
  }
}

module.exports = { TAX_RATE, getRevenueSummary, clearSummaryCache, roundHalfToEven };
