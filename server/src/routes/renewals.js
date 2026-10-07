const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');

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
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const error = new Error('Invalid month format. Expected YYYY-MM (e.g., 2026-10).');
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

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    if (due.length === 0) {
      return res.status(201).json({
        month,
        dueCount: 0,
        createdCount: 0,
        existedCount: 0,
        created: [],
        existed: []
      });
    }

    const bulkOps = due.map(sub => ({
      updateOne: {
        filter: { subscription: sub._id, billingMonth: month },
        update: {
          $setOnInsert: {
            subscription: sub._id,
            billingMonth: month,
            amount: sub.amount,
            currency: sub.currency,
          }
        },
        upsert: true
      }
    }));

    const result = await RenewalEvent.bulkWrite(bulkOps);
    
    // Object.values(result.upsertedIds) holds the _id values of newly inserted documents
    const upsertedIdStrings = new Set(Object.values(result.upsertedIds || {}).map(id => id.toString()));

    // Fetch all events involved
    const allEvents = await RenewalEvent.find({
      subscription: { $in: due.map(sub => sub._id) },
      billingMonth: month
    });

    const created = [];
    const existed = [];
    
    for (const event of allEvents) {
      if (upsertedIdStrings.has(event._id.toString())) {
        created.push(event);
      } else {
        existed.push(event);
      }
    }

    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existedCount: existed.length,
      created,
      existed,
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

    const events = await RenewalEvent.find({ billingMonth: month })
      .sort({ createdAt: 1 })
      .populate('subscription', 'name plan billingCycle');

    const items = events.map(event => toHistoryItem(event, event.subscription));

    res.json({ month, count: events.length, events: items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
