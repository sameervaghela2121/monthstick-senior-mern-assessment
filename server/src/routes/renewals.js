const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary, clearSummaryCache } = require('../services/revenueSummary');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('../services/paymentGateway');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;

const isValidMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

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

    if (!isValidMonth(month)) {
      return res.status(400).json({ error: 'Invalid month format YYYY-MM' });
    }

    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    // Checking before creating is safe here: Node runs JavaScript on a single thread, so two
    // requests can never be inside this loop at the same time.
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
        if (err.code === 11000) {
          existing.push(subscription._id);
          continue;
        }
        throw err;
      }
    }

    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existingCount: existing.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50
router.get('/', async (req, res, next) => {
  try {
    const { month, status } = req.query;
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || DEFAULT_PAGE_SIZE;

    if (month && !isValidMonth(month)) {
      return res.status(400).json({ error: 'Invalid month format YYYY-MM' });
    }

    if (status && !['scheduled', 'charged', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (!Number.isInteger(page) || page < 1) {
      return res.status(400).json({ error: 'Page must be integer >= 1' });
    }

    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      return res.status(400).json({ error: 'PageSize must be integer 1-200' });
    }

    const query = { billingMonth: month };
    if (status) {
      query.status = status;
    }

    const count = await RenewalEvent.countDocuments(query);
    const events = await RenewalEvent.find(query)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate('subscription');

    const items = events.map((event) => toHistoryItem(event, event.subscription));

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
    const { id } = req.params;
    const { status, failureReason } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ error: { message: 'Invalid event ID format' } });
    }
    if (!['charged', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status update' });
    }

    const update = {
      $inc: { attempts: 1 }
    };

    if (status === 'charged') {
      update.$set = { status, chargedAt: new Date(), failureReason: undefined };
    } else if (status === 'failed') {
      update.$set = { status, failureReason };
    }

    const event = await RenewalEvent.findOneAndUpdate(
      { _id: id, status: { $ne: 'charged' } },
      update,
      { new: true }
    );

    if (!event) {
      const existing = await RenewalEvent.findById(id);
      if (existing && existing.status === 'charged' && status === 'failed') {
        return res.status(409).json({ error: { message: `Cannot change status from charged to failed` } });
      }
      return res.status(404).json({ error: { message: 'Renewal event not found or transition rejected' } });
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
    const failed = await RenewalEvent.find({ billingMonth: month, status: 'failed' });

    let chargedCount = 0;
    let failedCount = 0;

    // chunk requests to prevent 429 errors from gateway
    for (let i = 0; i < failed.length; i += MAX_CONCURRENT_CHARGES) {
      const chunk = failed.slice(i, i + MAX_CONCURRENT_CHARGES);

      await Promise.all(chunk.map(async (event) => {
        try {
          const result = await paymentGateway.charge({
            eventId: String(event._id),
            amount: event.amount,
            currency: event.currency,
            idempotencyKey: `retry_${event._id}_${event.attempts}` // Prevents double charge
          });

          const update = { $inc: { attempts: 1 } };
          if (result.ok) {
            update.$set = { status: 'charged', chargedAt: new Date(), failureReason: undefined };
            chargedCount++;
          } else {
            update.$set = { failureReason: result.reason };
            failedCount++;
          }

          await RenewalEvent.updateOne({ _id: event._id, status: 'failed' }, update);
        } catch (gatewayErr) {
          failedCount++;
          await RenewalEvent.updateOne({ _id: event._id, status: 'failed' }, { $inc: { attempts: 1 } });
        }
      }));
    }

    clearSummaryCache();
    res.json({ month, retried: failed.length, charged: chargedCount, failed: failedCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
