const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const STATUSES = ['scheduled', 'charged', 'failed'];
const WEBHOOK_STATUSES = ['charged', 'failed'];
const MAX_FAILURE_REASON_LENGTH = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details) this.details = details;
  }
}

function badRequest(message, details) {
  return new HttpError(400, message, details);
}

function invalid(field, message) {
  return badRequest('Invalid request', [{ field, message }]);
}

function isMissing(value) {
  return value === undefined || value === '';
}

function parseMonth(value, field = 'month') {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw invalid(field, 'must be a month in YYYY-MM format');
  }
  return value;
}

// Accepts a query string or JSON number; rejects arrays, decimals and non-numeric strings.
function parseIntegerInRange(value, field, min, max) {
  const text = typeof value === 'number' ? String(value) : value;
  const number = typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
    throw invalid(field, `must be an integer ${range}`);
  }
  return number;
}

function parsePage(value) {
  if (isMissing(value)) return 1;
  return parseIntegerInRange(value, 'page', 1, Number.MAX_SAFE_INTEGER);
}

function parsePageSize(value) {
  if (isMissing(value)) return DEFAULT_PAGE_SIZE;
  return parseIntegerInRange(value, 'pageSize', 1, MAX_PAGE_SIZE);
}

function parseStatusFilter(value) {
  if (isMissing(value)) return null;
  if (!STATUSES.includes(value)) throw invalid('status', `must be one of ${STATUSES.join(', ')}`);
  return value;
}

function parseObjectId(value, field = 'id') {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalid(field, 'must be a 24-character hex id');
  }
  return value;
}

function parseWebhookBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body', 'must be a JSON object');
  }
  const { status, failureReason } = body;
  if (!WEBHOOK_STATUSES.includes(status)) {
    throw invalid('status', `must be one of ${WEBHOOK_STATUSES.join(', ')}`);
  }
  if (failureReason !== undefined && failureReason !== null) {
    if (typeof failureReason !== 'string' || failureReason.length > MAX_FAILURE_REASON_LENGTH) {
      throw invalid('failureReason', `must be a string of at most ${MAX_FAILURE_REASON_LENGTH} characters`);
    }
  }
  return { status, failureReason: failureReason ?? undefined };
}

module.exports = {
  HttpError,
  badRequest,
  parseMonth,
  parsePage,
  parsePageSize,
  parseStatusFilter,
  parseObjectId,
  parseWebhookBody,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
