const { RenewalEvent } = require('../models');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('./paymentGateway');
const { createLimiter } = require('../utils/limiter');

// One limiter for the whole process: the provider's limit applies to all our requests together,
// not to each HTTP request, so two admins retrying at once still share the same four slots.
const limitCharges = createLimiter(MAX_CONCURRENT_CHARGES);

// Retries currently running in this process, by event id. A second "Retry" click joins the attempt
// that is already running instead of starting another charge for the same event.
const inFlight = new Map();

function retryCharge(event) {
  const id = String(event._id);
  if (!inFlight.has(id)) {
    inFlight.set(
      id,
      limitCharges(() => chargeAndRecord(event)).finally(() => inFlight.delete(id)),
    );
  }
  return inFlight.get(id);
}

// Charges one failed event and records the outcome. Resolves to 'charged' or 'failed'.
async function chargeAndRecord(event) {
  let result;
  try {
    result = await paymentGateway.charge({
      eventId: String(event._id),
      amount: event.amount,
      currency: event.currency,
      // The same event and attempt number always produce the same key, so a repeat of this request
      // (double click, network retry, another API instance) gets the original result back from the
      // provider instead of a second charge. The next attempt gets a new key and is a new charge.
      idempotencyKey: `renewal-${event._id}-attempt-${event.attempts + 1}`,
    });
  } catch (err) {
    // The provider could not process the request (for example HTTP 429). It counts as a failed
    // attempt; the other retries carry on.
    console.warn(`[retry] gateway error for renewal event ${event._id}: ${err.message}`);
    result = { ok: false, reason: 'gateway_error' };
  }

  // Both writes are single atomic updates whose filter re-checks the state they rely on, so a
  // webhook or another instance recording the same attempt cannot be overwritten or double counted.
  if (result.ok) {
    await RenewalEvent.updateOne(
      { _id: event._id, status: 'failed' },
      { $set: { status: 'charged', chargedAt: new Date() }, $unset: { failureReason: '' }, $inc: { attempts: 1 } },
    );
    return 'charged';
  }

  await RenewalEvent.updateOne(
    { _id: event._id, status: 'failed', attempts: event.attempts },
    { $set: { failureReason: result.reason ?? 'declined' }, $inc: { attempts: 1 } },
  );
  return 'failed';
}

// Retries every failed charge of the month and resolves once all of them have been recorded.
async function retryFailedCharges(month) {
  const failedEvents = await RenewalEvent.find({ billingMonth: month, status: 'failed' })
    .select('amount currency attempts')
    .lean();

  const outcomes = await Promise.all(failedEvents.map(retryCharge));
  const charged = outcomes.filter((outcome) => outcome === 'charged').length;

  return { month, retried: failedEvents.length, charged, failed: failedEvents.length - charged };
}

module.exports = { retryFailedCharges };
