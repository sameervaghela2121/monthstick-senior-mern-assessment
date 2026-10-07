const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { validateMonth } = require('../middleware/validateMonth');

const router = express.Router();

const DUPLICATE_KEY_ERROR = 11000;

function toHistoryItem(event, subscription) {
  return {
    id: String(event._id),
    billingMonth: event.billingMonth,
    amount: event.amount,
    currency: event.currency,
    status: event.status,
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

// Creates the renewal event for each subscription unless one already exists for that month, in a single round trip.
// Each upsert matches on the unique (subscription, billingMonth) key, and $setOnInsert leaves existing events
// untouched, so re-running a month is idempotent. Resolves to the BulkWriteResult, whose `upsertedIds` maps
// operation index -> new event _id.
async function createMissingRenewalEvents(subscriptions, month) {
  const now = new Date();
  const operations = subscriptions.map((subscription) => ({
    updateOne: {
      filter: { subscription: subscription._id, billingMonth: month },
      update: {
        $setOnInsert: {
          amount: subscription.amount,
          currency: subscription.currency,
          createdAt: now,
          updatedAt: now,
        },
      },
      upsert: true,
      // Timestamps are set explicitly on insert only; otherwise every re-run would bump updatedAt on existing events.
      timestamps: false,
    },
  }));

  try {
    return await RenewalEvent.bulkWrite(operations, { ordered: false });
  } catch (err) {
    // Two concurrent runs can both miss the filter and race to insert; the unique index rejects the loser with
    // E11000. For us that means "the event already exists", which is the correct outcome, not a failure.
    // Any other error is unexpected and is rethrown.
    const writeErrors = err.writeErrors ?? [];
    const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((e) => e.code === DUPLICATE_KEY_ERROR);
    if (onlyDuplicates && err.result) return err.result;
    throw err;
  }
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', validateMonth('body'), async (req, res, next) => {
  try {
    const { month } = req.body;
    const { end } = getMonthRange(month);

    const candidates = await Subscription.find({ status: 'active', startDate: { $lt: end } })
      .select('name amount currency billingCycle startDate')
      .lean();
    const due = candidates.filter((subscription) => isDueInMonth(subscription, month));

    const { upsertedIds = {} } = due.length > 0 ? await createMissingRenewalEvents(due, month) : {};

    const created = [];
    const alreadyExisted = [];
    due.forEach((subscription, index) => {
      const item = { subscriptionId: String(subscription._id), name: subscription.name };
      const eventId = upsertedIds[index];
      if (eventId) created.push({ ...item, eventId: String(eventId) });
      else alreadyExisted.push(item);
    });

    // 201 only when this request actually created something; a repeat run is a successful no-op.
    res.status(created.length > 0 ? 201 : 200).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      alreadyExistedCount: alreadyExisted.length,
      created,
      alreadyExisted,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM
// One aggregation instead of 1 count + 1 find + N findById calls: the subscription details are joined on the
// server via the subscriptions _id index, and only the fields the history table needs are projected.
router.get('/', validateMonth('query'), async (req, res, next) => {
  try {
    const { month } = req.query;

    const events = await RenewalEvent.aggregate([
      { $match: { billingMonth: month } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $lookup: {
          from: Subscription.collection.name,
          localField: 'subscription',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1, plan: 1, billingCycle: 1 } }],
          as: 'subscription',
        },
      },
    ]);

    res.json({
      month,
      count: events.length,
      events: events.map((event) => toHistoryItem(event, event.subscription[0])),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
