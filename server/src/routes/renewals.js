const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary } = require('../services/revenueSummary');
const { retryFailedCharges } = require('../services/chargeRetry');
const { parseMonthInput, parseHistoryQuery, parseStatusUpdate } = require('../utils/validation');

const router = express.Router();

const DUPLICATE_KEY = 11000;

const ALLOWED_TRANSITIONS = {
  scheduled: ['charged', 'failed'],
  failed: ['charged', 'failed'],
  charged: [],
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

// True when the insert failed only because some events already exist.
function isDuplicateKeyError(err) {
  const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [];
  if (writeErrors.length === 0) return err.code === DUPLICATE_KEY;
  return writeErrors.every((writeError) => (writeError.code ?? writeError.err?.code) === DUPLICATE_KEY);
}

// Inserts one renewal event per subscription and returns the events this call actually wrote.
// When two runs race, the unique index lets exactly one insert through per subscription; the loser
// gets a duplicate-key error, which simply means "already exists". Any other error is rethrown.
async function insertRenewalEvents(subscriptions, month) {
  if (subscriptions.length === 0) return [];

  const events = subscriptions.map((subscription) => ({
    subscription: subscription._id,
    billingMonth: month,
    amount: subscription.amount,
    currency: subscription.currency,
    uniquePerMonth: true,
  }));

  try {
    // Unordered, so one duplicate does not stop the rest of the batch from being written.
    return await RenewalEvent.insertMany(events, { ordered: false, throwOnValidationError: true });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return err.insertedDocs ?? [];
  }
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const { month } = parseMonthInput(req.body);
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } })
      .select('name amount currency billingCycle startDate')
      .lean();
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    // One query for the whole month instead of one per subscription. It skips work that is already
    // done and covers legacy events, but it is not what prevents duplicates: two requests can both
    // read "nothing yet". The unique index in insertRenewalEvents is the guarantee.
    const billed = new Set((await RenewalEvent.distinct('subscription', { billingMonth: month })).map(String));
    const missing = due.filter((subscription) => !billed.has(String(subscription._id)));

    const inserted = await insertRenewalEvents(missing, month);
    const createdIds = new Set(inserted.map((event) => String(event.subscription)));

    const summarise = (subscription) => ({ id: String(subscription._id), name: subscription.name });
    const created = due.filter((subscription) => createdIds.has(String(subscription._id)));
    const existing = due.filter((subscription) => !createdIds.has(String(subscription._id)));

    // 201 when this request created something, 200 when it was a repeat that changed nothing.
    res.status(created.length > 0 ? 201 : 200).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existingCount: existing.length,
      created: created.map(summarise),
      existing: existing.map(summarise),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=failed
router.get('/', async (req, res, next) => {
  try {
    const { month, page, pageSize, status } = parseHistoryQuery(req.query);
    const filter = status ? { billingMonth: month, status } : { billingMonth: month };

    // Two queries however many rows are returned: the count, and one page of events joined to
    // their subscriptions. Sorting on (createdAt, _id) matches the indexes and gives every event a
    // fixed position, so paging returns each one exactly once.
    const [count, events] = await Promise.all([
      RenewalEvent.countDocuments(filter),
      RenewalEvent.aggregate([
        { $match: filter },
        { $sort: { createdAt: 1, _id: 1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $lookup: {
            from: Subscription.collection.name,
            localField: 'subscription',
            foreignField: '_id',
            pipeline: [{ $project: { name: 1, plan: 1, billingCycle: 1 } }],
            as: 'subscription',
          },
        },
        { $unwind: { path: '$subscription', preserveNullAndEmptyArrays: true } },
      ]),
    ]);

    res.json({
      month,
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
    const { month } = parseMonthInput(req.query);
    res.json(await getRevenueSummary(month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "failureReason"?: string }
// Called by the payment provider's webhook. Every accepted call records one charge attempt.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id, status, failureReason } = parseStatusUpdate(req.params, req.body);

    const allowedFrom = Object.keys(ALLOWED_TRANSITIONS).filter((from) => ALLOWED_TRANSITIONS[from].includes(status));
    const change =
      status === 'charged'
        ? { $set: { status, chargedAt: new Date() }, $unset: { failureReason: '' } }
        : failureReason === undefined
          ? { $set: { status }, $unset: { failureReason: '' } }
          : { $set: { status, failureReason } };

    // One atomic update. The filter re-checks the transition at write time, so a late or duplicate
    // "failed" can never replace "charged", and $inc counts every accepted webhook exactly once
    // even when several arrive together. (Read, modify, save lost both of those under concurrency.)
    const event = await RenewalEvent.findOneAndUpdate(
      { _id: id, status: { $in: allowedFrom } },
      { ...change, $inc: { attempts: 1 } },
      { new: true },
    )
      .populate('subscription', 'name plan billingCycle')
      .lean();

    if (!event) {
      const current = await RenewalEvent.findById(id).select('status').lean();
      if (!current) {
        return res.status(404).json({ error: { message: 'Renewal event not found' } });
      }
      return res
        .status(409)
        .json({ error: { message: `Cannot change status from ${current.status} to ${status}` } });
    }

    res.json(toHistoryItem(event, event.subscription));
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
router.post('/retry-failed', async (req, res, next) => {
  try {
    const { month } = parseMonthInput(req.body);
    res.json(await retryFailedCharges(month));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
