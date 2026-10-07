class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const FILTER_STATUSES = ['scheduled', 'charged', 'failed'];
const UPDATE_STATUSES = ['charged', 'failed'];

function requireMonth(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) {
    throw new HttpError(400, 'month must be YYYY-MM');
  }
  return month;
}

function requirePage(value) {
  if (value === undefined || value === '') return 1;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new HttpError(400, 'page must be an integer greater than or equal to 1');
  }
  return Number(value);
}

function requirePageSize(value) {
  if (value === undefined || value === '') return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'pageSize must be an integer between 1 and 200');
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 200) {
    throw new HttpError(400, 'pageSize must be an integer between 1 and 200');
  }
  return parsed;
}

function optionalStatus(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !FILTER_STATUSES.includes(value)) {
    throw new HttpError(400, 'status must be one of scheduled, charged, failed');
  }
  return value;
}

function requireUpdateStatus(value) {
  if (typeof value !== 'string' || !UPDATE_STATUSES.includes(value)) {
    throw new HttpError(400, 'status must be charged or failed');
  }
  return value;
}

function optionalFailureReason(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'failureReason must be a string');
  }
  return value;
}

function requireObjectId(value) {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new HttpError(400, 'id must be a valid event id');
  }
  return value;
}

module.exports = {
  HttpError,
  requireMonth,
  requirePage,
  requirePageSize,
  optionalStatus,
  requireUpdateStatus,
  optionalFailureReason,
  requireObjectId,
};
