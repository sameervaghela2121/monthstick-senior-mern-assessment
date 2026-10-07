const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary, invalidateRevenueSummary } = require('../services/revenueSummary');
const { paymentGateway } = require('../services/paymentGateway');
const { isDuplicateKeyError } = require('../services/renewalIntegrity');
const { withChargeSlot } = require('../services/chargeGate');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;

// Target status → statuses it may be applied to. `charged` is absent as a source, so it is final.
const TRANSITIONS_FROM = {
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

function toRunItem(event, subscription) {
  return {
    id: String(event._id),
    subscriptionId: String(subscription._id),
    name: subscription.name,
    status: event.status,
  };
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const { month } = req.body;
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    // The unique (subscription, billingMonth) index is what makes a repeated or
    // overlapping run safe. A duplicate key is an event that already existed.
    // Any other database error is passed on.
    const created = [];
    const alreadyExisted = [];
    for (const subscription of due) {
      const existing = await RenewalEvent.findOne({
        subscription: subscription._id,
        billingMonth: month,
      });
      if (existing) {
        alreadyExisted.push(toRunItem(existing, subscription));
        continue;
      }

      try {
        const event = await RenewalEvent.create({
          subscription: subscription._id,
          billingMonth: month,
          amount: subscription.amount,
          currency: subscription.currency,
        });
        created.push(toRunItem(event, subscription));
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        const winner = await RenewalEvent.findOne({
          subscription: subscription._id,
          billingMonth: month,
        });
        if (!winner) throw err;
        alreadyExisted.push(toRunItem(winner, subscription));
      }
    }

    if (created.length > 0) invalidateRevenueSummary(month);

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
// Called by the payment provider's webhook. Every accepted call records one charge attempt.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, failureReason } = req.body;
    const allowedFrom = TRANSITIONS_FROM[status];

    if (!allowedFrom) {
      const current = await RenewalEvent.findById(req.params.id);
      if (!current) {
        return res.status(404).json({ error: { message: 'Renewal event not found' } });
      }
      return res
        .status(409)
        .json({ error: { message: `Cannot change status from ${current.status} to ${status}` } });
    }

    const update = {
      $inc: { attempts: 1 },
      $set: { status },
    };
    if (status === 'charged') {
      update.$set.chargedAt = new Date();
      update.$unset = { failureReason: 1 };
    } else {
      update.$set.failureReason = failureReason ?? null;
    }

    // The filter and the write are one document update, so a late "failed"
    // webhook cannot overwrite "charged", and attempt increments are not lost.
    const event = await RenewalEvent.findOneAndUpdate(
      { _id: req.params.id, status: { $in: allowedFrom } },
      update,
      { new: true },
    );

    if (!event) {
      const current = await RenewalEvent.findById(req.params.id);
      if (!current) {
        return res.status(404).json({ error: { message: 'Renewal event not found' } });
      }
      return res
        .status(409)
        .json({ error: { message: `Cannot change status from ${current.status} to ${status}` } });
    }

    invalidateRevenueSummary(event.billingMonth);
    const subscription = await Subscription.findById(event.subscription);
    res.json(toHistoryItem(event, subscription));
  } catch (err) {
    next(err);
  }
});

async function retryEvent(event) {
  const idempotencyKey = `renewal:${event._id}:${event.attempts + 1}`;
  let result;
  try {
    result = await withChargeSlot(() =>
      paymentGateway.charge({
        eventId: String(event._id),
        amount: event.amount,
        currency: event.currency,
        idempotencyKey,
      }),
    );
  } catch (err) {
    // A gateway rejection, including 429, is a failed attempt. It must not abort the batch.
    result = { ok: false, reason: err.message || 'gateway_error' };
  }

  const update = result.ok
    ? {
        $inc: { attempts: 1 },
        $set: { status: 'charged', chargedAt: new Date() },
        $unset: { failureReason: 1 },
      }
    : {
        $inc: { attempts: 1 },
        $set: { status: 'failed', failureReason: result.reason || 'gateway_error' },
      };

  // Same attempt number means the same idempotency key. The attempts guard records
  // that attempt once when two retries overlap.
  const updated = await RenewalEvent.findOneAndUpdate(
    { _id: event._id, status: 'failed', attempts: event.attempts },
    update,
    { new: true },
  );

  if (!updated) return { recorded: false };
  return { recorded: true, charged: Boolean(result.ok) };
}

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
router.post('/retry-failed', async (req, res, next) => {
  try {
    const { month } = req.body;
    const failed = await RenewalEvent.find({ billingMonth: month, status: 'failed' });
    const outcomes = await Promise.all(failed.map((event) => retryEvent(event)));

    let charged = 0;
    let stillFailed = 0;
    for (const outcome of outcomes) {
      if (!outcome.recorded) continue;
      if (outcome.charged) charged += 1;
      else stillFailed += 1;
    }

    if (charged + stillFailed > 0) invalidateRevenueSummary(month);

    res.json({
      month,
      retried: charged + stillFailed,
      charged,
      failed: stillFailed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
