const express = require('express');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth } = require('../utils/billing');
const { clearSummaryCache, getRevenueSummary } = require('../services/revenueSummary');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('../services/paymentGateway');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const VALID_STATUSES = ['scheduled', 'charged', 'failed'];
const ALLOWED_TRANSITIONS = {
  scheduled: ['charged', 'failed'],
  failed: ['charged', 'failed'],
  charged: [],
};
const RETRY_LOCK_MS = 5 * 60 * 1000;
let activeChargeRequests = 0;
const queuedChargeRequests = [];

function chargeWithLimit(request) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeChargeRequests += 1;
      try {
        resolve(await paymentGateway.charge(request));
      } catch (error) {
        reject(error);
      } finally {
        activeChargeRequests -= 1;
        const next = queuedChargeRequests.shift();
        if (next) next();
      }
    };
    if (activeChargeRequests < MAX_CONCURRENT_CHARGES) execute();
    else queuedChargeRequests.push(execute);
  });
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function validateMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw badRequest('month must be a valid month in YYYY-MM format');
  }
  if (value.startsWith('0000')) throw badRequest('month year must be greater than 0000');
  return value;
}

function optionalSingleQueryValue(value, name) {
  if (Array.isArray(value)) throw badRequest(`${name} must be provided once`);
  return value;
}

function parsePositiveInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw badRequest(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw badRequest(`${name} must not exceed ${maximum}`);
  }
  return parsed;
}

function toHistoryItem(event) {
  const subscription = event.subscription;
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

function duplicateKeyError(error) {
  return error?.code === 11000;
}

// POST /api/renewals/run  { "month": "YYYY-MM" }
router.post('/run', async (req, res, next) => {
  try {
    const month = validateMonth(req.body?.month);
    const { end } = getMonthRange(month);
    const subscriptions = await Subscription.find({ status: 'active', startDate: { $lt: end } });
    const due = subscriptions.filter((subscription) => isDueInMonth(subscription, month));
    const existingEvents = await RenewalEvent.find({
      billingMonth: month,
      subscription: { $in: due.map((subscription) => subscription._id) },
    }).select('_id subscription').lean();
    const existingBySubscription = new Map(
      existingEvents.map((event) => [String(event.subscription), event]),
    );
    const created = [];
    const alreadyExisted = [];

    for (const subscription of due) {
      const subscriptionId = String(subscription._id);
      const existing = existingBySubscription.get(subscriptionId);
      if (existing) {
        alreadyExisted.push(String(existing._id));
        continue;
      }

      try {
        const event = await RenewalEvent.create({
          subscription: subscription._id,
          billingMonth: month,
          deduplicationKey: `${subscriptionId}:${month}`,
          amount: subscription.amount,
          currency: subscription.currency,
        });
        created.push(String(event._id));
      } catch (error) {
        if (!duplicateKeyError(error)) throw error;
        const concurrentEvent = await RenewalEvent.findOne({
          subscription: subscription._id,
          billingMonth: month,
        }).select('_id').lean();
        if (!concurrentEvent) throw error;
        alreadyExisted.push(String(concurrentEvent._id));
      }
    }

    if (created.length) clearSummaryCache(month);
    res.status(created.length ? 201 : 200).json({
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

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=failed
router.get('/', async (req, res, next) => {
  try {
    const month = validateMonth(optionalSingleQueryValue(req.query.month, 'month'));
    const page = parsePositiveInteger(
      optionalSingleQueryValue(req.query.page, 'page'),
      'page',
      1,
    );
    const pageSize = parsePositiveInteger(
      optionalSingleQueryValue(req.query.pageSize, 'pageSize'),
      'pageSize',
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const status = optionalSingleQueryValue(req.query.status, 'status');
    if (status !== undefined && status !== '' && !VALID_STATUSES.includes(status)) {
      throw badRequest('status must be scheduled, charged, or failed');
    }

    const filter = { billingMonth: month };
    if (status) filter.status = status;
    const count = await RenewalEvent.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(count / pageSize));
    const currentPage = Math.min(page, totalPages);
    const events = await RenewalEvent.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .populate('subscription', '_id name plan billingCycle')
      .lean();

    res.json({
      month,
      count,
      page: currentPage,
      pageSize,
      totalPages,
      events: events.map(toHistoryItem),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/summary?month=YYYY-MM
router.get('/summary', async (req, res, next) => {
  try {
    const month = validateMonth(optionalSingleQueryValue(req.query.month, 'month'));
    res.json(await getRevenueSummary(month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status  { "status": "charged" | "failed", "attemptId"?: string }
router.patch('/:id/status', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw badRequest('id must be a valid event id');
    const { status, failureReason, attemptId } = req.body || {};
    if (typeof status !== 'string' || !['charged', 'failed'].includes(status)) {
      throw badRequest('status must be charged or failed');
    }
    if (failureReason !== undefined
      && (typeof failureReason !== 'string' || failureReason.length > 500)) {
      throw badRequest('failureReason must be a string of at most 500 characters');
    }
    if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > 200) {
      throw badRequest('attemptId is required and must be a non-empty string of at most 200 characters');
    }

    const filter = {
      _id: req.params.id,
      status: { $in: Object.keys(ALLOWED_TRANSITIONS).filter((current) =>
        ALLOWED_TRANSITIONS[current].includes(status)) },
    };
    filter.processedAttemptIds = { $ne: attemptId };
    const update = {
      $set: { status },
      $inc: { attempts: 1 },
      $unset: { retryClaimedAt: 1, retryAttemptKey: 1 },
    };
    if (status === 'failed' && failureReason !== undefined) {
      update.$set.failureReason = failureReason;
    } else {
      update.$unset.failureReason = 1;
    }
    if (status === 'charged') update.$set.chargedAt = new Date();
    update.$addToSet = { processedAttemptIds: attemptId };

    let event = await RenewalEvent.findOneAndUpdate(filter, update, { new: true });
    if (!event) {
      event = await RenewalEvent.findOne({
        _id: req.params.id,
        processedAttemptIds: attemptId,
      });
    }
    if (!event) {
      const current = await RenewalEvent.findById(req.params.id);
      if (!current) return res.status(404).json({ error: { message: 'Renewal event not found' } });
      return res.status(409).json({
        error: { message: `Cannot change status from ${current.status} to ${status}` },
      });
    }

    clearSummaryCache(event.billingMonth);
    const populatedEvent = await RenewalEvent.populate(event, {
      path: 'subscription',
      select: '_id name plan billingCycle',
    });
    res.json(toHistoryItem(populatedEvent));
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/retry-failed  { "month": "YYYY-MM" }
router.post('/retry-failed', async (req, res, next) => {
  try {
    const month = validateMonth(req.body?.month);
    const failedEvents = await RenewalEvent.find({ billingMonth: month, status: 'failed' })
      .select('_id attempts retryAttemptKey')
      .lean();
    const staleLockBefore = new Date(Date.now() - RETRY_LOCK_MS);
    let nextIndex = 0;
    let retried = 0;
    let charged = 0;
    let stillFailed = 0;
    let firstError;

    async function processNext() {
      while (nextIndex < failedEvents.length) {
        const candidate = failedEvents[nextIndex++];
        const eventId = candidate._id;
        const claimedAt = new Date();
        const retryAttemptKey = candidate.retryAttemptKey || `${eventId}:${candidate.attempts + 1}`;
        const claimUpdate = {
          $set: { retryClaimedAt: claimedAt, retryAttemptKey },
        };
        if (!candidate.retryAttemptKey) claimUpdate.$inc = { attempts: 1 };
        const event = await RenewalEvent.findOneAndUpdate(
          {
            _id: eventId,
            billingMonth: month,
            status: 'failed',
            $or: [
              { retryClaimedAt: { $exists: false } },
              { retryClaimedAt: null },
              { retryClaimedAt: { $lt: staleLockBefore } },
            ],
          },
          claimUpdate,
          { new: true },
        );
        if (!event) continue;
        retried += 1;

        try {
          const result = await chargeWithLimit({
            eventId: String(event._id),
            amount: event.amount,
            currency: event.currency,
            idempotencyKey: event.retryAttemptKey,
          });
          const update = result.ok
            ? { $set: { status: 'charged', chargedAt: new Date() }, $unset: { failureReason: 1 } }
            : { $set: { failureReason: result.reason } };
          const saved = await RenewalEvent.findOneAndUpdate(
            { _id: event._id, status: 'failed', retryClaimedAt: claimedAt },
            {
              ...update,
              $unset: { ...update.$unset, retryClaimedAt: 1, retryAttemptKey: 1 },
            },
            { new: true },
          );
          const finalStatus = saved
            ? saved.status
            : (await RenewalEvent.findById(event._id).select('status')).status;
          if (finalStatus === 'charged') charged += 1;
          else stillFailed += 1;
          clearSummaryCache(month);
        } catch (error) {
          await RenewalEvent.updateOne(
            { _id: event._id, status: 'failed', retryClaimedAt: claimedAt },
            { $unset: { retryClaimedAt: 1 } },
          );
          firstError ||= error;
        }
      }
    }

    const workerResults = await Promise.allSettled(
      Array.from({ length: Math.min(MAX_CONCURRENT_CHARGES, failedEvents.length) }, () => processNext()),
    );
    const workerError = workerResults.find((result) => result.status === 'rejected')?.reason;
    if (workerError) return next(workerError);
    if (firstError) return next(firstError);
    res.json({ month, retried, charged, failed: stillFailed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
