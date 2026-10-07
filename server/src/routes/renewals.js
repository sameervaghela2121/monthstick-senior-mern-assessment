const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary, clearSummaryCache } = require('../services/revenueSummary');
const { paymentGateway } = require('../services/paymentGateway');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_FAILURE_REASON_LENGTH = 500;

const ALLOWED_TRANSITIONS = {
  scheduled: ['charged', 'failed'],
  failed: ['charged', 'failed'],
  charged: [],
};

const ALLOWED_STATUSES = ['scheduled', 'charged', 'failed'];

// Validation helpers
function isValidMonth(month) {
  return /^\d{4}-\d{2}$/.test(month) && !isNaN(Date.parse(`${month}-01`));
}

function isValidPage(page) {
  return Number.isInteger(page) && page >= 1;
}

function isValidPageSize(pageSize) {
  return Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE;
}

function isValidObjectId(id) {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

function isValidFailureReason(reason) {
  if (reason === undefined || reason === null) return true;
  if (typeof reason !== 'string') return false;
  if (reason.length > MAX_FAILURE_REASON_LENGTH) return false;
  return true;
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

    if (!month || !isValidMonth(month)) {
      return res.status(400).json({
        error: { message: 'Invalid month format. Expected YYYY-MM (e.g., 2026-10).' },
      });
    }

    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    const created = [];
    const existing = [];

    for (const subscription of due) {
      try {
        const event = await RenewalEvent.create({
          subscription: subscription._id,
          billingMonth: month,
          amount: subscription.amount,
          currency: subscription.currency,
        });
        created.push(event);
      } catch (err) {
        // The unique compound index is the concurrency boundary. A competing
        // request may win between our insert and this duplicate-key response.
        if (
          err.code === 11000 &&
          err.keyPattern?.subscription &&
          err.keyPattern?.billingMonth
        ) {
          const existingEvent = await RenewalEvent.findOne({
            subscription: subscription._id,
            billingMonth: month,
          });
          if (existingEvent) {
            existing.push(existingEvent);
          } else {
            // Do not disguise an unrelated duplicate-key failure (or a
            // transiently unavailable winner) as a successful idempotent run.
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    // Clear cache since we've modified events
    clearSummaryCache();

    res.status(created.length > 0 ? 201 : 200).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existingCount: existing.length,
      created: created.map((e) => String(e._id)),
      existing: existing.map((e) => String(e._id)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=scheduled
router.get('/', async (req, res, next) => {
  try {
    const { month, status } = req.query;
    // Only use default if parameter is not provided; validate explicitly if provided
    const page = req.query.page !== undefined ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize !== undefined ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;

    if (!month || !isValidMonth(month)) {
      return res.status(400).json({
        error: { message: 'Invalid month format. Expected YYYY-MM (e.g., 2026-10).' },
      });
    }

    if (!isValidPage(page)) {
      return res.status(400).json({
        error: { message: 'page must be a positive integer' },
      });
    }

    if (!isValidPageSize(pageSize)) {
      return res.status(400).json({
        error: { message: `pageSize must be between 1 and ${MAX_PAGE_SIZE}` },
      });
    }

    if (status && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        error: { message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
      });
    }

    const query = { billingMonth: month };
    if (status) {
      query.status = status;
    }

    const count = await RenewalEvent.countDocuments(query);
    const events = await RenewalEvent.find(query)
      .sort({ createdAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate('subscription', 'name plan billingCycle')
      .lean();

    const items = events.map((event) => toHistoryItem(event, event.subscription));

    res.json({
      month,
      status: status || null,
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

    if (!month || !isValidMonth(month)) {
      return res.status(400).json({
        error: { message: 'Invalid month format. Expected YYYY-MM (e.g., 2026-10).' },
      });
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
    const { status, failureReason } = req.body;

    // Validate status parameter
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        error: { message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
      });
    }

    // Validate event ID format
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: { message: 'Invalid renewal event ID format' },
      });
    }

    // Validate failure reason if provided
    if (!isValidFailureReason(failureReason)) {
      return res.status(400).json({
        error: { message: `failureReason must be a string with maximum ${MAX_FAILURE_REASON_LENGTH} characters` },
      });
    }

    const event = await RenewalEvent.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: { message: 'Renewal event not found' } });
    }

    // Validate status transition
    if (!ALLOWED_TRANSITIONS[event.status].includes(status)) {
      return res
        .status(409)
        .json({ error: { message: `Cannot change status from ${event.status} to ${status}` } });
    }

    // Update event
    event.status = status;
    event.attempts += 1;
    event.failureReason = status === 'failed' ? failureReason : undefined;
    if (status === 'charged') event.chargedAt = new Date();
    await event.save();

    // Clear cache since we've modified events
    clearSummaryCache();

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

    if (!month || !isValidMonth(month)) {
      return res.status(400).json({
        error: { message: 'Invalid month format. Expected YYYY-MM (e.g., 2026-10).' },
      });
    }

    const failed = await RenewalEvent.find({ billingMonth: month, status: 'failed' });

    const retried = [];
    const errors = [];

    // Process charges sequentially to respect the MAX_CONCURRENT_CHARGES limit
    for (const event of failed) {
      try {
        const result = await paymentGateway.charge({
          eventId: String(event._id),
          amount: event.amount,
          currency: event.currency,
          idempotencyKey: `retry_${event._id}_${event.attempts}`,
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
        retried.push({ id: String(event._id), success: result.ok });
      } catch (err) {
        errors.push({ id: String(event._id), error: err.message });
      }
    }

    // Clear cache since we've modified events
    clearSummaryCache();

    res.json({ month, retried: retried.length, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
