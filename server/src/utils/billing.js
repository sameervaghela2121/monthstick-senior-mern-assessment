function parseMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw Object.assign(new Error('Month must be in YYYY-MM format'), { status: 400 });
  }

  const [year, monthNumber] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw Object.assign(new Error('Month must be a valid date in YYYY-MM format'), { status: 400 });
  }

  if (start.getUTCFullYear() !== year || start.getUTCMonth() + 1 !== monthNumber) {
    throw Object.assign(new Error('Month must be in YYYY-MM format'), { status: 400 });
  }

  return { year, monthNumber, start, end };
}

function getMonthRange(month) {
  return parseMonth(month);
}

function toMonthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isDueInMonth(subscription, month) {
  const startMonth = toMonthKey(subscription.startDate);
  if (month < startMonth) return false;
  if (subscription.billingCycle === 'monthly') return true;
  return month.slice(5, 7) === startMonth.slice(5, 7);
}

module.exports = { getMonthRange, isDueInMonth, toMonthKey, parseMonth };
