const express = require('express');
const { randomUUID } = require('node:crypto');
const { Subscription, RenewalEvent } = require('../models');
const { getMonthRange, isDueInMonth, parseMonth } = require('../utils/billing');
const { getRevenueSummary, clearSummaryCache } = require('../services/revenueSummary');
const { paymentGateway, MAX_CONCURRENT_CHARGES } = require('../services/paymentGateway');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_FAILURE_REASON_LENGTH = 200;
const RETRY_LOCK_TTL_MS = 5 * 60 * 1000;
const GATEWAY_SLOT_TTL_MS = 5 * 60 * 1000;
const GATEWAY_HEARTBEAT_MS = 60 * 1000;
const RETRY_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
const VALID_STATUSES = new Set(['scheduled', 'charged', 'failed']);
let activeGatewayRequests = 0;
const gatewayRequestQueue = [];

const ALLOWED_TRANSITIONS = {
  scheduled: ['charged', 'failed'],
  failed: ['charged', 'failed'],
  charged: [],
};

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parsePageValue(value, fallback) {
  const page = Number(value ?? fallback);
  if (!Number.isInteger(page) || page < 1) {
    throw badRequest('Page must be a positive integer.');
  }
  return page;
}

function parsePageSizeValue(value, fallback) {
  const pageSize = Number(value ?? fallback);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw badRequest(`Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return pageSize;
}

function normalizeStatus(status) {
  if (status == null || status === '') return null;
  const value = String(status).toLowerCase();
  if (!VALID_STATUSES.has(value)) {
    throw badRequest('Status filter must be one of: scheduled, charged, failed.');
  }
  return value;
}

function validateAttemptId(attemptId) {
  if (
    typeof attemptId !== 'string' ||
    attemptId.length < 1 ||
    attemptId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(attemptId)
  ) {
    throw badRequest('attemptId must be a non-empty identifier of at most 128 valid characters.');
  }
  return attemptId;
}

function validateFailureReason(failureReason) {
  if (
    failureReason !== undefined &&
    (typeof failureReason !== 'string' || failureReason.length > MAX_FAILURE_REASON_LENGTH)
  ) {
    throw badRequest(`failureReason must be a string of at most ${MAX_FAILURE_REASON_LENGTH} characters.`);
  }
}

async function withGatewayConcurrencyLimit(callback) {
  if (activeGatewayRequests >= MAX_CONCURRENT_CHARGES) {
    await new Promise((resolve) => gatewayRequestQueue.push(resolve));
  }

  activeGatewayRequests += 1;
  let slotToken;
  let heartbeat;
  let heartbeatError;
  try {
    slotToken = await acquireGatewaySlot();
    heartbeat = setInterval(() => {
      renewGatewaySlot(slotToken).catch((error) => {
        heartbeatError = error;
      });
    }, GATEWAY_HEARTBEAT_MS);
    heartbeat.unref?.();
    const result = await callback();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(heartbeat);
    try {
      if (slotToken) await releaseGatewaySlot(slotToken);
    } finally {
      activeGatewayRequests -= 1;
      gatewayRequestQueue.shift()?.();
    }
  }
}

async function acquireGatewaySlot() {
  const collection = RenewalEvent.db.collection('payment_gateway_slots');

  while (true) {
    for (let slot = 0; slot < MAX_CONCURRENT_CHARGES; slot += 1) {
      const token = randomUUID();
      const now = new Date();
      try {
        const result = await collection.updateOne(
          {
            _id: slot,
            $or: [
              { acquiredAt: { $exists: false } },
              { acquiredAt: { $lt: new Date(now.getTime() - GATEWAY_SLOT_TTL_MS) } },
            ],
          },
          { $set: { token, acquiredAt: now }, $setOnInsert: { _id: slot } },
          { upsert: true },
        );
        if (result.matchedCount === 1 || result.upsertedCount === 1) return token;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function releaseGatewaySlot(token) {
  await RenewalEvent.db.collection('payment_gateway_slots').updateOne(
    { token },
    { $unset: { token: 1, acquiredAt: 1 } },
  );
}

async function renewGatewaySlot(token) {
  const result = await RenewalEvent.db.collection('payment_gateway_slots').updateOne(
    { token },
    { $set: { acquiredAt: new Date() } },
  );
  if (result.matchedCount !== 1) {
    throw new Error('Lost the payment gateway concurrency lease.');
  }
}

class GatewayAttemptError extends Error {
  constructor(error) {
    super(error.message || 'Payment gateway request failed.', { cause: error });
    this.name = 'GatewayAttemptError';
  }
}

async function chargeGateway(request) {
  try {
    const result = await paymentGateway.charge(request);
    if (!result || typeof result.ok !== 'boolean') {
      throw new Error('Payment gateway returned an invalid result.');
    }
    return result;
  } catch (error) {
    throw new GatewayAttemptError(error);
  }
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
    const month = req.body?.month;
    parseMonth(month);
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
          status: 'scheduled',
          attempts: 0,
        });
        created.push(event);
      } catch (error) {
        if (error?.code === 11000) {
          existing.push(String(subscription._id));
          continue;
        }
        throw error;
      }
    }

    clearSummaryCache();

    res.status(201).json({
      month,
      dueCount: due.length,
      createdCount: created.length,
      existingCount: existing.length,
      created: created.map((event) => ({ id: String(event._id), subscription: String(event.subscription) })),
      existing: existing.map((subscriptionId) => ({ subscription: subscriptionId })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals?month=YYYY-MM&page=1&pageSize=50&status=scheduled|charged|failed
router.get('/', async (req, res, next) => {
  try {
    const month = req.query.month;
    parseMonth(month);
    const page = parsePageValue(req.query.page, 1);
    const pageSize = parsePageSizeValue(req.query.pageSize, DEFAULT_PAGE_SIZE);
    const status = normalizeStatus(req.query.status);

    const filter = { billingMonth: month };
    if (status) filter.status = status;

    const count = await RenewalEvent.countDocuments(filter);
    const events = await RenewalEvent.aggregate([
      { $match: filter },
      { $sort: { createdAt: 1, _id: 1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      {
        $lookup: {
          from: 'subscriptions',
          localField: 'subscription',
          foreignField: '_id',
          as: 'subscriptionDoc',
        },
      },
      { $unwind: { path: '$subscriptionDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          billingMonth: 1,
          amount: 1,
          currency: 1,
          status: 1,
          attempts: 1,
          failureReason: 1,
          chargedAt: 1,
          createdAt: 1,
          subscription: {
            $cond: [
              '$subscriptionDoc',
              {
                _id: '$subscriptionDoc._id',
                name: '$subscriptionDoc.name',
                plan: '$subscriptionDoc.plan',
                billingCycle: '$subscriptionDoc.billingCycle',
              },
              null,
            ],
          },
        },
      },
    ]);

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
    const month = req.query.month;
    parseMonth(month);
    res.json(await getRevenueSummary(month));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/renewals/:id/status { "status": "charged" | "failed", "attemptId": "...", "failureReason"?: string }
// Called by the payment provider's webhook. Each distinct attemptId is recorded once.
router.patch('/:id/status', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      throw badRequest('Event id must be a valid MongoDB ObjectId.');
    }

    const status = req.body?.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      throw badRequest('Status must be one of: charged, failed.');
    }
    if (status === 'scheduled') {
      throw badRequest('Status must be one of: charged, failed.');
    }
    const attemptId = validateAttemptId(req.body?.attemptId);
    validateFailureReason(req.body?.failureReason);

    const currentEvent = await RenewalEvent.findById(req.params.id);
    if (!currentEvent) {
      return res.status(404).json({ error: { message: 'Renewal event not found' } });
    }
    if (currentEvent.processedAttemptIds.includes(attemptId)) {
      const subscription = await Subscription.findById(currentEvent.subscription);
      return res.json(toHistoryItem(currentEvent, subscription));
    }
    if (!ALLOWED_TRANSITIONS[currentEvent.status].includes(status)) {
      return res.status(409).json({
        error: { message: `Cannot change status from ${currentEvent.status} to ${status}` },
      });
    }

    const event = await RenewalEvent.findOneAndUpdate(
      {
        _id: req.params.id,
        status: currentEvent.status,
        processedAttemptIds: { $ne: attemptId },
      },
      {
        $set: {
          status,
          failureReason: status === 'failed' ? req.body.failureReason ?? null : null,
          ...(status === 'charged' ? { chargedAt: new Date() } : {}),
        },
        $inc: { attempts: 1 },
        $addToSet: { processedAttemptIds: attemptId },
        $unset: { retryToken: 1, retryAttemptId: 1, retryAttemptStartedAt: 1, retryLockedAt: 1 },
      },
      { new: true, runValidators: true },
    );

    if (!event) {
      const latestEvent = await RenewalEvent.findById(req.params.id);
      if (!latestEvent) {
        return res.status(404).json({ error: { message: 'Renewal event not found' } });
      }
      if (latestEvent.processedAttemptIds.includes(attemptId)) {
        const subscription = await Subscription.findById(latestEvent.subscription);
        return res.json(toHistoryItem(latestEvent, subscription));
      }
      if (!ALLOWED_TRANSITIONS[latestEvent.status].includes(status)) {
        return res.status(409).json({
          error: { message: `Cannot change status from ${latestEvent.status} to ${status}` },
        });
      }
      return res.status(409).json({ error: { message: 'Renewal event changed; retry with the same attemptId.' } });
    }

    clearSummaryCache();

    const subscription = await Subscription.findById(event.subscription);
    res.json(toHistoryItem(event, subscription));
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/retry-failed { "month": "YYYY-MM" }
// Retries once per failed event and reports attempts requiring manual reconciliation.
router.post('/retry-failed', async (req, res, next) => {
  try {
    const month = req.body?.month;
    parseMonth(month);
    const candidates = await RenewalEvent.find({ billingMonth: month, status: 'failed' }).select('_id').lean();
    const results = [];
    let nextCandidate = 0;
    let workerError = null;

    async function retryNext() {
      while (!workerError && nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++];
        const now = new Date();
        const attemptId = randomUUID();
        const token = randomUUID();
        const event = await RenewalEvent.findOneAndUpdate(
          {
            _id: candidate._id,
            billingMonth: month,
            status: 'failed',
            $and: [
              {
                $or: [
                  { retryAttemptStartedAt: { $exists: false } },
                  {
                    retryAttemptStartedAt: {
                      $gte: new Date(now.getTime() - RETRY_IDEMPOTENCY_WINDOW_MS),
                    },
                  },
                ],
              },
              {
                $or: [
                  { retryLockedAt: { $exists: false } },
                  { retryLockedAt: { $lt: new Date(now.getTime() - RETRY_LOCK_TTL_MS) } },
                ],
              },
            ],
          },
          [
            {
              $set: {
                retryToken: token,
                retryLockedAt: now,
                retryAttemptId: { $ifNull: ['$retryAttemptId', attemptId] },
                retryAttemptStartedAt: { $ifNull: ['$retryAttemptStartedAt', now] },
              },
            },
          ],
          { new: true },
        );
        if (!event) continue;
        const gatewayAttemptId = `retry-failed:${String(event._id)}:${event.retryAttemptId}`;

        let result;
        let failureReason;
        try {
          result = await withGatewayConcurrencyLimit(() =>
            chargeGateway({
              eventId: String(event._id),
              amount: event.amount,
              currency: event.currency,
              idempotencyKey: gatewayAttemptId,
            }),
          );
          if (!result.ok) {
            failureReason =
              typeof result.reason === 'string'
                ? result.reason.slice(0, MAX_FAILURE_REASON_LENGTH)
                : 'payment_failed';
          }
        } catch (gatewayError) {
          if (!(gatewayError instanceof GatewayAttemptError)) throw gatewayError;
          failureReason = (gatewayError.message || 'gateway_error').slice(0, MAX_FAILURE_REASON_LENGTH);
          result = { ok: false };
        }

        const update = {
          $inc: { attempts: 1 },
          $addToSet: { processedAttemptIds: gatewayAttemptId },
          $set: result.ok
            ? { status: 'charged', chargedAt: new Date(), failureReason: null }
            : { status: 'failed', failureReason },
          $unset: {
            retryToken: 1,
            retryAttemptId: 1,
            retryAttemptStartedAt: 1,
            retryLockedAt: 1,
          },
        };
        const completed = await RenewalEvent.findOneAndUpdate(
          { _id: event._id, status: 'failed', retryToken: token },
          update,
          { new: true, runValidators: true },
        );
        if (completed) {
          results.push(completed.status);
        } else {
          const latest = await RenewalEvent.findById(event._id).select('status').lean();
          if (latest) results.push(latest.status);
        }
      }
    }

    async function runWorker() {
      try {
        await retryNext();
      } catch (error) {
        if (!workerError) workerError = error;
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_CHARGES, candidates.length) }, runWorker),
    );
    if (workerError) throw workerError;

    const charged = results.filter((status) => status === 'charged').length;
    const failedCount = results.filter((status) => status === 'failed').length;
    const reconciliationRequired = await RenewalEvent.countDocuments({
      billingMonth: month,
      status: 'failed',
      retryAttemptStartedAt: { $lt: new Date(Date.now() - RETRY_IDEMPOTENCY_WINDOW_MS) },
      $or: [
        { retryLockedAt: { $exists: false } },
        { retryLockedAt: { $lt: new Date(Date.now() - RETRY_LOCK_TTL_MS) } },
      ],
    });
    if (results.length) clearSummaryCache();
    res.json({ month, retried: results.length, charged, failed: failedCount, reconciliationRequired });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
