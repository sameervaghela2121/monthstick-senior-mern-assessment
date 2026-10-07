// Simulated payment provider. Behaves like the real one in the ways that matter:
//  - it is slow and sometimes declines cards;
//  - it rejects more than MAX_CONCURRENT_CHARGES simultaneous requests with HTTP 429;
//  - it supports idempotency keys: a request with a key that was already used returns the
//    original result instead of charging the card again (keys are remembered for 24h).
//
// Call it as `paymentGateway.charge(...)` (tests replace this method with a stub that
// follows the same contract).

export const MAX_CONCURRENT_CHARGES = 4;
const DECLINE_RATE = 0.25;

class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

let inFlight = 0;
const idempotentResults = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function performCharge({ eventId, amount, currency }) {
  if (inFlight >= MAX_CONCURRENT_CHARGES) {
    throw new GatewayError('Too many concurrent requests', 429);
  }
  inFlight++;
  try {
    await sleep(30 + Math.random() * 70);
    if (Math.random() < DECLINE_RATE) {
      return { ok: false, reason: 'card_declined' };
    }
    return { ok: true, chargeId: `ch_${eventId}_${Date.now()}`, amount, currency };
  } finally {
    inFlight--;
  }
}

const paymentGateway = {
  // charge({ eventId, amount, currency, idempotencyKey? })
  // Resolves to { ok: true, chargeId } or { ok: false, reason }. Rejects with GatewayError on transport errors.
  charge(request) {
    const { idempotencyKey } = request;
    if (!idempotencyKey) return performCharge(request);

    if (!idempotentResults.has(idempotencyKey)) {
      const pending = performCharge(request);
      idempotentResults.set(idempotencyKey, pending);
      // Transport errors are not remembered, so the same key can be retried.
      pending.catch(() => idempotentResults.delete(idempotencyKey));
    }
    return idempotentResults.get(idempotencyKey);
  },
};

module.exports = { paymentGateway, GatewayError, MAX_CONCURRENT_CHARGES };
