const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary, clearSummaryCache } = require('../services/revenueSummary');
const { paymentGateway } = require('../services/paymentGateway');
const mongoose = require('mongoose');
const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;

const ALLOWED_TRANSITIONS = {
  scheduled: ['charged', 'failed'],
  failed: ['charged', 'failed'],
  charged: [],
};

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const VALID_EVENT_STATUSES = ['scheduled', 'charged', 'failed'];

function isValidMonth(month) {
  return typeof month === 'string' && MONTH_REGEX.test(month);
}


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
    if (!isValidMonth(month)) {
      return res.status(400).json({ error: { message: 'Invalid or missing month. Expected format YYYY-MM.' } });
    }

    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    let createdCount = 0;
    let existingCount = 0;

    for (const subscription of due) {
      // 1. Check if renewal already exists for this month
      const existing = await RenewalEvent.findOne({
        subscription: subscription._id,
        billingMonth: month,
      });
      if (existing) {
        existingCount++;
        continue;
      }

      // 2. Safe creation with concurrency guard
      try {
        await RenewalEvent.create({
          subscription: subscription._id,
          billingMonth: month,
          amount: subscription.amount,
          currency: subscription.currency,
        });
        createdCount++;
      } catch (err) {
        if (err.code === 11000) {
          existingCount++;
          continue;
        }
        throw err;
      }
    }
    if (createdCount > 0) {
      clearSummaryCache(month);
    }
    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount,
      existingCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50
router.get('/', async (req, res, next) => {
  try {
    const { month, status } = req.query;

    if (!isValidMonth(month)) {
      return res.status(400).json({ error: { message: 'Invalid or missing month. Expected format YYYY-MM.' } });
    }

    const page = req.query.page !== undefined ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize !== undefined ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;

    if (!Number.isInteger(page) || page < 1) {
      return res.status(400).json({ error: { message: 'page must be a positive integer.' } });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      return res.status(400).json({ error: { message: 'pageSize must be an integer between 1 and 200.' } });
    }
    if (status && !VALID_EVENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID_EVENT_STATUSES.join(', ')}` } });
    }

    const filter = { billingMonth: month };
    if (status) filter.status = status;

    const count = await RenewalEvent.countDocuments(filter);
    const events = await RenewalEvent.find(filter)
      .populate('subscription')
      .sort({ createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    const items = events.map((event) => toHistoryItem(event, event.subscription));

    res.json({
      month,
      count,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      events: items,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/summary?month=YYYY-MM
router.get('/summary', async (req, res, next) => {
  try {
    const { month } = req.query;
    if (!isValidMonth(month)) {
      return res.status(400).json({ error: { message: 'Invalid or missing month. Expected format YYYY-MM.' } });
    }
    res.json(await getRevenueSummary(month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "failureReason"?: string }
// Called by the payment provider's webhook. Every call records one charge attempt.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, failureReason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: { message: 'Invalid event id format.' } });
    }
    if (!['charged', 'failed'].includes(status)) {
      return res.status(400).json({ error: { message: 'status must be "charged" or "failed".' } });
    }

    const event = await RenewalEvent.findById(id);
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

    clearSummaryCache(event.billingMonth);

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
    if (!isValidMonth(month)) {
      return res.status(400).json({ error: { message: 'Invalid or missing month. Expected format YYYY-MM.' } });
    }

    const failedEvents = await RenewalEvent.find({ billingMonth: month, status: 'failed' });
    let chargedCount = 0;
    let failedCount = 0;

    // Concurrency limit of 3 (payment gateway limit is 4)
    const CONCURRENCY_LIMIT = 3;
    const queue = [...failedEvents];

    async function processEvent(event) {
      const nextAttempt = event.attempts + 1;
      const idempotencyKey = `retry-${event._id}-${nextAttempt}`;

      try {
        const result = await paymentGateway.charge({
          eventId: String(event._id),
          amount: event.amount,
          currency: event.currency,
          idempotencyKey,
        });

        event.attempts = nextAttempt;
        if (result.ok) {
          event.status = 'charged';
          event.chargedAt = new Date();
          event.failureReason = undefined;
          chargedCount++;
        } else {
          event.status = 'failed';
          event.failureReason = result.reason || 'declined';
          failedCount++;
        }
      } catch (err) {
        // Gateway transport or 429 errors count as a recorded failed attempt
        event.attempts = nextAttempt;
        event.status = 'failed';
        event.failureReason = err.message || 'gateway_error';
        failedCount++;
      }
      await event.save();
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, queue.length) }, async () => {
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) {
          await processEvent(event);
        }
      }
    });

    await Promise.all(workers);

    if (chargedCount > 0) {
      clearSummaryCache(month);
    }

    res.json({
      month,
      retried: failedEvents.length,
      charged: chargedCount,
      failed: failedCount,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
