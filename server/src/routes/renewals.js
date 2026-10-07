const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth, isValidMonth } = require('../utils/billing');

const router = express.Router();

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

function validateMonth(month) {
  if (!isValidMonth(month)) {
    const error = new Error('Invalid month. Expected YYYY-MM, for example 2026-10.');
    error.status = 400;
    throw error;
  }
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const { month } = req.body;
    validateMonth(month);

    const { end } = getMonthRange(month);
    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } }).lean();
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    let createdCount = 0;
    let existingCount = 0;
    const created = [];
    const existing = [];

    for (const subscription of due) {
      const result = await RenewalEvent.updateOne(
        { subscription: subscription._id, billingMonth: month },
        {
          $setOnInsert: {
            subscription: subscription._id,
            billingMonth: month,
            amount: subscription.amount,
            currency: subscription.currency,
            status: 'scheduled',
          },
        },
        { upsert: true },
      );

      if (result.upsertedCount > 0) {
        createdCount += 1;
        created.push({
          id: String(subscription._id),
          name: subscription.name,
          plan: subscription.plan,
        });
      } else {
        existingCount += 1;
        existing.push({
          id: String(subscription._id),
          name: subscription.name,
          plan: subscription.plan,
        });
      }
    }

    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount,
      existingCount,
      created,
      existing,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM
router.get('/', async (req, res, next) => {
  try {
    const { month } = req.query;
    validateMonth(month);

    const count = await RenewalEvent.countDocuments({ billingMonth: month });
    const events = await RenewalEvent.aggregate([
      { $match: { billingMonth: month } },
      { $sort: { createdAt: 1 } },
      {
        $lookup: {
          from: 'subscriptions',
          localField: 'subscription',
          foreignField: '_id',
          as: 'subscriptionDetails',
        },
      },
      {
        $project: {
          _id: 1,
          subscription: { $arrayElemAt: ['$subscriptionDetails', 0] },
          billingMonth: 1,
          amount: 1,
          currency: 1,
          status: 1,
          createdAt: 1,
        },
      },
    ]);

    const items = events.map((event) => toHistoryItem(event, event.subscription));

    res.json({ month, count, events: items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
