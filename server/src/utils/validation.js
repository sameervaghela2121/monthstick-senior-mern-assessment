// Request validation. Each parse* function returns clean values or throws a BadRequestError that
// lists every invalid field, so routes never pass unchecked input to MongoDB.

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_FAILURE_REASON_LENGTH = 200;
const EVENT_STATUSES = ['scheduled', 'charged', 'failed'];
const WEBHOOK_STATUSES = ['charged', 'failed'];

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIGITS_PATTERN = /^\d+$/;
const EVENT_ID_PATTERN = /^[0-9a-f]{24}$/i;

class BadRequestError extends Error {
  constructor(details) {
    super(details.map(({ field, message }) => `${field} ${message}`).join('; '));
    this.name = 'BadRequestError';
    this.status = 400;
    // Tells the error handler this message was written for the client.
    this.expose = true;
    this.details = details;
  }
}

function assertValid(errors) {
  if (errors.length > 0) throw new BadRequestError(errors);
}

// Values are compared by type first: a query string or JSON body can carry arrays and objects
// (for example ?month[$ne]=x), which must never reach a database filter.
function parseMonth(value, errors) {
  if (typeof value === 'string' && MONTH_PATTERN.test(value)) return value;
  errors.push({ field: 'month', message: 'must be a month in YYYY-MM format, for example 2026-10' });
  return undefined;
}

function parseInteger(value, errors, { field, min, max = Number.MAX_SAFE_INTEGER, fallback }) {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && DIGITS_PATTERN.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(number) && number >= min && number <= max) return number;
  const range = max === Number.MAX_SAFE_INTEGER ? `of ${min} or more` : `between ${min} and ${max}`;
  errors.push({ field, message: `must be a whole number ${range}` });
  return undefined;
}

// An empty status means "all", which is what the dashboard's "All" option sends.
function parseStatusFilter(value, errors) {
  if (value === undefined || value === '') return undefined;
  if (EVENT_STATUSES.includes(value)) return value;
  errors.push({ field: 'status', message: `must be one of: ${EVENT_STATUSES.join(', ')}` });
  return undefined;
}

// { month } from a JSON body or a query string.
function parseMonthInput(source) {
  const errors = [];
  const month = parseMonth(source?.month, errors);
  assertValid(errors);
  return { month };
}

function parseHistoryQuery(query) {
  const errors = [];
  const month = parseMonth(query.month, errors);
  const page = parseInteger(query.page, errors, { field: 'page', min: 1, fallback: 1 });
  const pageSize = parseInteger(query.pageSize, errors, {
    field: 'pageSize',
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });
  const status = parseStatusFilter(query.status, errors);
  assertValid(errors);
  return { month, page, pageSize, status };
}

function parseStatusUpdate(params, body) {
  const errors = [];
  const { status, failureReason } = body ?? {};

  if (!EVENT_ID_PATTERN.test(params.id)) {
    errors.push({ field: 'id', message: 'must be a 24-character hexadecimal event id' });
  }
  if (!WEBHOOK_STATUSES.includes(status)) {
    errors.push({ field: 'status', message: `must be one of: ${WEBHOOK_STATUSES.join(', ')}` });
  }
  if (failureReason != null && (typeof failureReason !== 'string' || failureReason.length > MAX_FAILURE_REASON_LENGTH)) {
    errors.push({ field: 'failureReason', message: `must be text of at most ${MAX_FAILURE_REASON_LENGTH} characters` });
  }
  assertValid(errors);

  return { id: params.id, status, failureReason: status === 'failed' ? failureReason ?? undefined : undefined };
}

module.exports = {
  BadRequestError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  EVENT_STATUSES,
  WEBHOOK_STATUSES,
  parseMonthInput,
  parseHistoryQuery,
  parseStatusUpdate,
};
