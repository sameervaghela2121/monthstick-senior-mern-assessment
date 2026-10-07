const { RenewalEvent } = require('../models');

// GST is 18%, applied per renewal event in integer cents.
const TAX_RATE = 0.18;
const GST_NUMERATOR = 18;
const GST_DENOMINATOR = 100;

// Half-even (banker's) rounding. A remainder of exactly 50 keeps an even quotient.
function gstCents(amountCents) {
  const product = amountCents * GST_NUMERATOR;
  const quotient = Math.floor(product / GST_DENOMINATOR);
  const remainder = product % GST_DENOMINATOR;
  const half = GST_DENOMINATOR / 2;
  if (remainder > half) return quotient + 1;
  if (remainder < half) return quotient;
  return quotient % 2 === 0 ? quotient : quotient + 1;
}

async function getRevenueSummary(month) {
  const events = await RenewalEvent.find({ billingMonth: month }).lean();

  const byStatus = { scheduled: 0, charged: 0, failed: 0 };
  let subtotal = 0;
  let tax = 0;
  for (const event of events) {
    subtotal += event.amount;
    tax += gstCents(event.amount);
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

function clearSummaryCache() {
  // Summaries are calculated from the database on every request.
}

module.exports = { TAX_RATE, gstCents, getRevenueSummary, clearSummaryCache };
