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

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const { month } = req.body;
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    const created = [];
    for (const subscription of due) {
      const existing = await RenewalEvent.findOne({
        subscription: subscription._id,
        billingMonth: month,
      });
      if (existing) continue;

      const event = await RenewalEvent.create({
        subscription: subscription._id,
        billingMonth: month,
        amount: subscription.amount,
        currency: subscription.currency,
      });
      created.push(event);
    }

    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM
router.get('/', async (req, res, next) => {
  try {
    const { month } = req.query;

    const count = await RenewalEvent.countDocuments({ billingMonth: month });
    const events = await RenewalEvent.find({ billingMonth: month }).sort({ createdAt: 1 });

    const items = [];
    for (const event of events) {
      const subscription = await Subscription.findById(event.subscription);
      items.push(toHistoryItem(event, subscription));
    }

    res.json({ month, count, events: items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
