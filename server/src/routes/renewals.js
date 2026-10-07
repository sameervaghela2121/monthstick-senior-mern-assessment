const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { getRevenueSummary } = require('../services/revenueSummary');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('../services/paymentGateway');
const {
  requireMonth,
  requirePage,
  requirePageSize,
  optionalStatus,
  requireUpdateStatus,
  optionalFailureReason,
  requireObjectId,
} = require('../validation');

const router = express.Router();

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

function eventRef(event) {
  const subscriptionId = event.subscription?._id || event.subscription;
  return {
    id: String(event._id),
    subscriptionId: String(subscriptionId),
  };
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.cause?.code === 11000;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const month = requireMonth(req.body?.month);
    const { end } = getMonthRange(month);

    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));

    const created = [];
    const alreadyExisted = [];
    for (const subscription of due) {
      const filter = { subscription: subscription._id, billingMonth: month };
      const existing = await RenewalEvent.findOne(filter);
      if (existing) {
        alreadyExisted.push(existing);
        continue;
      }

      try {
        const event = await RenewalEvent.create({
          subscription: subscription._id,
          billingMonth: month,
          amount: subscription.amount,
          currency: subscription.currency,
        });
        created.push(event);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const raced = await RenewalEvent.findOne(filter);
        if (!raced) throw err;
        alreadyExisted.push(raced);
      }
    }

    res.status(created.length > 0 ? 201 : 200).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      alreadyExistedCount: alreadyExisted.length,
      created: created.map(eventRef),
      alreadyExisted: alreadyExisted.map(eventRef),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=
router.get('/', async (req, res, next) => {
  try {
    const month = requireMonth(req.query.month);
    const page = requirePage(req.query.page);
    const pageSize = requirePageSize(req.query.pageSize);
    const status = optionalStatus(req.query.status);

    const filter = { billingMonth: month };
    if (status) filter.status = status;

    const count = await RenewalEvent.countDocuments(filter);
    const events = await RenewalEvent.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate('subscription');

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
    const month = requireMonth(req.query.month);
    res.json(await getRevenueSummary(month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "failureReason"?: string }
// Called by the payment provider's webhook. Every call records one charge attempt.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const id = requireObjectId(req.params.id);
    const status = requireUpdateStatus(req.body?.status);
    const failureReason = optionalFailureReason(req.body?.failureReason);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const event = await RenewalEvent.findById(id);
      if (!event) {
        return res.status(404).json({ error: { message: 'Renewal event not found' } });
      }

      const allowed = ALLOWED_TRANSITIONS[event.status].includes(status);
      if (!allowed) {
        const recorded = await RenewalEvent.updateOne(
          { _id: id, status: event.status },
          { $inc: { attempts: 1 } },
        );
        const matched = recorded.matchedCount ?? recorded.n ?? 0;
        if (matched === 0) continue;
        return res
          .status(409)
          .json({ error: { message: `Cannot change status from ${event.status} to ${status}` } });
      }

      const update = {
        $inc: { attempts: 1 },
        $set: { status },
      };
      if (status === 'charged') {
        update.$set.chargedAt = new Date();
        update.$unset = { failureReason: 1 };
      } else if (failureReason !== undefined) {
        update.$set.failureReason = failureReason;
      }

      const updated = await RenewalEvent.findOneAndUpdate(
        { _id: id, status: event.status },
        update,
        { new: true },
      );
      if (!updated) continue;

      const subscription = await Subscription.findById(updated.subscription);
      return res.json(toHistoryItem(updated, subscription));
    }

    return res.status(409).json({ error: { message: 'Could not apply status update' } });
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
router.post('/retry-failed', async (req, res, next) => {
  try {
    const month = requireMonth(req.body?.month);
    const failed = await RenewalEvent.find({ billingMonth: month, status: 'failed' });

    const outcomes = await mapPool(failed, MAX_CONCURRENT_CHARGES, async (event) => {
      const eventId = String(event._id);
      let result;
      try {
        result = await paymentGateway.charge({
          eventId,
          amount: event.amount,
          currency: event.currency,
          idempotencyKey: `${eventId}:${event.attempts + 1}`,
        });
      } catch (err) {
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
            $set: { failureReason: result.reason || 'gateway_error' },
          };

      const applied = await RenewalEvent.findOneAndUpdate(
        { _id: event._id, status: 'failed', attempts: event.attempts },
        update,
        { new: true },
      );
      if (!applied) {
        const current = await RenewalEvent.findById(event._id);
        return current?.status === 'charged' ? 'charged' : 'failed';
      }
      return result.ok ? 'charged' : 'failed';
    });

    res.json({
      month,
      retried: failed.length,
      charged: outcomes.filter((outcome) => outcome === 'charged').length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
