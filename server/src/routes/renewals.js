const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary } = require('../services/revenueSummary');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('../services/paymentGateway');
const {
  HttpError,
  parseMonth,
  parsePage,
  parsePageSize,
  parseStatusFilter,
  parseObjectId,
  parseWebhookBody,
} = require('../utils/validation');

const router = express.Router();

const DUPLICATE_KEY = 11000;
const SUBSCRIPTION_FIELDS = 'name plan billingCycle';

// Business rule 3: the states each target status may be reached from. `charged` is final.
const ALLOWED_FROM = {
  charged: ['scheduled', 'failed'],
  failed: ['scheduled', 'failed'],
};

function toHistoryItem(event, subscription) {
  return {
    id: String(event._id),
    billingMonth: event.billingMonth,
    amount: event.amount,
    currency: event.currency,
    status: event.status,
    attempts: event.attempts,
    failureReason: event.failureReason ?? null,
    chargedAt: event.chargedAt ?? null,
    createdAt: event.createdAt,
    subscription: subscription
      ? {
          id: String(subscription._id),
          name: subscription.name,
          plan: subscription.plan,
          billingCycle: subscription.billingCycle,
        }
      : null,
  };
}

// True for a bulk insert error in which every failed write is a duplicate key, i.e. those
// events already exist (from an earlier or concurrent run). Anything else is a real failure.
function isOnlyDuplicateKeyErrors(err) {
  const writeErrors = err?.writeErrors && [].concat(err.writeErrors);
  return (
    Array.isArray(writeErrors) &&
    writeErrors.length > 0 &&
    writeErrors.every((writeError) => (writeError.code ?? writeError.err?.code) === DUPLICATE_KEY)
  );
}

// Inserts the docs, tolerating ones that already exist. Returns the inserted documents.
async function insertNewEvents(docs) {
  if (docs.length === 0) return [];
  try {
    return await RenewalEvent.insertMany(docs, { ordered: false });
  } catch (err) {
    if (!isOnlyDuplicateKeyErrors(err)) throw err;
    return err.insertedDocs ?? [];
  }
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
// Idempotent: the unique index on { subscription, billingMonth } guarantees at most one event per
// subscription and month, even for concurrent runs. Events that already existed are reported.
router.post('/run', async (req, res, next) => {
  try {
    const month = parseMonth(req.body?.month);
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } }).lean();
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    const inserted = await insertNewEvents(
      due.map((subscription) => ({
        subscription: subscription._id,
        billingMonth: month,
        amount: subscription.amount,
        currency: subscription.currency,
      })),
    );

    const createdBySubscription = new Map(inserted.map((event) => [String(event.subscription), event]));
    const notCreated = due.filter((subscription) => !createdBySubscription.has(String(subscription._id)));
    const existingEvents = notCreated.length
      ? await RenewalEvent.find(
          { billingMonth: month, subscription: { $in: notCreated.map((s) => s._id) } },
          { subscription: 1 },
        ).lean()
      : [];
    const existingBySubscription = new Map(existingEvents.map((event) => [String(event.subscription), event]));

    const created = [];
    const existing = [];
    for (const subscription of due) {
      const key = String(subscription._id);
      const entry = (event) => ({ id: String(event._id), subscriptionId: key, name: subscription.name });
      if (createdBySubscription.has(key)) created.push(entry(createdBySubscription.get(key)));
      else if (existingBySubscription.has(key)) existing.push(entry(existingBySubscription.get(key)));
      // Neither inserted nor already present: the insert silently dropped it. Never hide that.
      else throw new Error(`Renewal event for subscription ${key} in ${month} was not created`);
    }

    res.status(created.length > 0 ? 201 : 200).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existingCount: existing.length,
      created,
      existing,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=failed
router.get('/', async (req, res, next) => {
  try {
    const month = parseMonth(req.query.month);
    const page = parsePage(req.query.page);
    const pageSize = parsePageSize(req.query.pageSize);
    const status = parseStatusFilter(req.query.status);

    const filter = { billingMonth: month, ...(status && { status }) };
    const [count, events] = await Promise.all([
      RenewalEvent.countDocuments(filter),
      RenewalEvent.find(filter)
        // _id breaks createdAt ties so pages never overlap or skip events (business rule 5).
        .sort({ createdAt: 1, _id: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        // One `$in` query for the page's subscriptions instead of one query per event.
        .populate('subscription', SUBSCRIPTION_FIELDS)
        .lean(),
    ]);

    res.json({
      month,
      status,
      count,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      events: events.map((event) => toHistoryItem(event, event.subscription)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/summary?month=YYYY-MM
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await getRevenueSummary(parseMonth(req.query.month)));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "failureReason"?: string }
// Called by the payment provider's webhook, which may deliver duplicates or out of order. Every
// accepted call records one charge attempt. The transition check and the update are a single
// atomic operation, so concurrent webhooks can neither lose attempts nor overwrite `charged`.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    const { status, failureReason } = parseWebhookBody(req.body);

    const update = { $set: { status }, $inc: { attempts: 1 } };
    if (status === 'charged') {
      update.$set.chargedAt = new Date();
      update.$unset = { failureReason: 1 };
    } else if (failureReason !== undefined) {
      update.$set.failureReason = failureReason;
    } else {
      update.$unset = { failureReason: 1 };
    }

    const event = await RenewalEvent.findOneAndUpdate(
      { _id: id, status: { $in: ALLOWED_FROM[status] } },
      update,
      { new: true },
    )
      .populate('subscription', SUBSCRIPTION_FIELDS)
      .lean();

    if (!event) {
      const current = await RenewalEvent.findById(id, { status: 1 }).lean();
      if (!current) throw new HttpError(404, 'Renewal event not found');
      throw new HttpError(409, `Cannot change status from ${current.status} to ${status}`);
    }

    res.json(toHistoryItem(event, event.subscription));
  } catch (err) {
    next(err);
  }
});

// Runs `worker(item)` for every item with at most `limit` running at once. Resolves when all
// have settled; `worker` must not reject.
async function forEachWithConcurrency(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function chargeEvent(event) {
  try {
    return await paymentGateway.charge({
      eventId: String(event._id),
      amount: event.amount,
      currency: event.currency,
      // One key per (event, attempt): a concurrent retry of the same failed state reuses the key,
      // so the provider returns the original result instead of charging the card twice.
      idempotencyKey: `renewal:${event._id}:attempt:${event.attempts + 1}`,
    });
  } catch (err) {
    // Transport errors (e.g. 429) count as a failed attempt.
    return { ok: false, reason: err?.status ? `gateway_error_${err.status}` : 'gateway_error' };
  }
}

// Records the attempt only if nobody else recorded it first. Returns true when recorded.
async function recordAttempt(event, result) {
  const update = result.ok
    ? { $set: { status: 'charged', chargedAt: new Date() }, $unset: { failureReason: 1 }, $inc: { attempts: 1 } }
    : { $set: { failureReason: result.reason || 'unknown' }, $inc: { attempts: 1 } };
  const { matchedCount } = await RenewalEvent.updateOne(
    { _id: event._id, status: 'failed', attempts: event.attempts },
    update,
  );
  return matchedCount === 1;
}

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
// Responds once every retry has been charged and recorded.
router.post('/retry-failed', async (req, res, next) => {
  try {
    const month = parseMonth(req.body?.month);
    const failedEvents = await RenewalEvent.find(
      { billingMonth: month, status: 'failed' },
      { amount: 1, currency: 1, attempts: 1 },
    ).lean();

    const totals = { charged: 0, failed: 0, skipped: 0 };
    let firstError = null;
    await forEachWithConcurrency(failedEvents, MAX_CONCURRENT_CHARGES, async (event) => {
      try {
        const result = await chargeEvent(event);
        if (!(await recordAttempt(event, result))) totals.skipped += 1;
        else if (result.ok) totals.charged += 1;
        else totals.failed += 1;
      } catch (err) {
        // A database error while recording: keep going for the others, then report a 500.
        firstError ??= err;
      }
    });
    if (firstError) throw firstError;

    res.json({
      month,
      retried: totals.charged + totals.failed,
      charged: totals.charged,
      failed: totals.failed,
      skipped: totals.skipped,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
