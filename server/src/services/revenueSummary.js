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
  let tax = 0;

  for (const event of events) {
    subtotal += event.amount; // operate integer cents

    // Calculate per-event tax, banker's rounding (round to even)
    const eventTaxRaw = event.amount * TAX_RATE;
    const integerPart = Math.floor(eventTaxRaw);
    const fractionalPart = eventTaxRaw - integerPart;
    let eventTax;

    if (fractionalPart < 0.5) {
      eventTax = integerPart;
    } else if (fractionalPart > 0.5) {
      eventTax = integerPart + 1;
    } else {
      eventTax = integerPart % 2 === 0 ? integerPart : integerPart + 1;
    }

    tax += eventTax;
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

function clearSummaryCache() {
  cache.clear();
}

module.exports = { TAX_RATE, getRevenueSummary, clearSummaryCache };
