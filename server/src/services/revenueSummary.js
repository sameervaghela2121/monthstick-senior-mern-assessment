const { RenewalEvent } = require('../models');

// GST applied to every renewal.
const TAX_RATE = 0.18;

// Summaries are expensive to build for large months, so they are cached per month.
const cache = new Map();
const cacheVersions = new Map();
let cacheGeneration = 0;

function calculateTaxCents(amount) {
  const numerator = amount * TAX_RATE_NUMERATOR;
  const quotient = Math.floor(numerator / TAX_RATE_DENOMINATOR);
  const remainder = numerator % TAX_RATE_DENOMINATOR;

  if (remainder * 2 > TAX_RATE_DENOMINATOR) return quotient + 1;
  if (remainder * 2 < TAX_RATE_DENOMINATOR) return quotient;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

const TAX_RATE_NUMERATOR = 18;
const TAX_RATE_DENOMINATOR = 100;

async function getRevenueSummary(month) {
  if (cache.has(month)) return cache.get(month);
  const version = cacheVersions.get(month) || 0;
  const generation = cacheGeneration;

  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  for (const event of events) {
    subtotal += event.amount;
    tax += calculateTaxCents(event.amount);
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

  if (cacheGeneration === generation && (cacheVersions.get(month) || 0) === version) {
    cache.set(month, summary);
  }
  return summary;
}

function clearSummaryCache(month) {
  if (month) {
    cache.delete(month);
    cacheVersions.set(month, (cacheVersions.get(month) || 0) + 1);
  } else {
    cache.clear();
    cacheVersions.clear();
    cacheGeneration += 1;
  }
}

module.exports = { TAX_RATE, calculateTaxCents, getRevenueSummary, clearSummaryCache };
