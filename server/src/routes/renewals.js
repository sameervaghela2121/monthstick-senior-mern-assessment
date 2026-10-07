const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary } = require('../services/revenueSummary');
const { paymentGateway } = require('../services/paymentGateway');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;

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

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const { month } = req.body;
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    // Checking before creating is safe here: Node runs JavaScript on a single thread, so two
    // requests can never be inside this loop at the same time.
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

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50
router.get('/', async (req, res, next) => {
  try {
    const { month } = req.query;
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || DEFAULT_PAGE_SIZE;

    const count = await RenewalEvent.countDocuments({ billingMonth: month });
    const events = await RenewalEvent.find({ billingMonth: month })
      .sort({ createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    const items = [];
    for (const event of events) {
      const subscription = await Subscription.findById(event.subscription);
      items.push(toHistoryItem(event, subscription));
    }

    res.json({
      month,
      count,
      page,
      pageSize,
      totalPages: Math.max(1, Math.floor(count / pageSize)),
      events: items,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/summary?month=YYYY-MM
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await getRevenueSummary(req.query.month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "failureReason"?: string }
// Called by the payment provider's webhook. Every call records one charge attempt.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, failureReason } = req.body;

    const event = await RenewalEvent.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: { message: 'Renewal event not found' } });
    }
    if (!ALLOWED_TRANSITIONS[event.status].includes(status)) {
      return res
        .status(409)
        .json({ error: { message: `Cannot change status from ${event.status} to ${status}` } });
    }

    event.status = status;
    event.attempts += 1;
    event.failureReason = status === 'failed' ? failureReason : undefined;
    if (status === 'charged') event.chargedAt = new Date();
    await event.save();

    const subscription = await Subscription.findById(event.subscription);
    res.json(toHistoryItem(event, subscription));
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
router.post('/retry-failed', async (req, res, next) => {
  try {
    const { month } = req.body;
    const failed = await RenewalEvent.find({ billingMonth: month, status: 'failed' });

    failed.forEach(async (event) => {
      const result = await paymentGateway.charge({
        eventId: String(event._id),
        amount: event.amount,
        currency: event.currency,
      });

      event.attempts += 1;
      if (result.ok) {
        event.status = 'charged';
        event.chargedAt = new Date();
        event.failureReason = undefined;
      } else {
        event.failureReason = result.reason;
      }
      await event.save();
    });

    res.json({ month, retried: failed.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
