// YYYY-MM with a real month number (01-12).
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isValidMonth(month) {
  return MONTH_PATTERN.test(month);
}

function getMonthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

function toMonthKey(date) {
  return date.toISOString().slice(0, 7);
}

function isDueInMonth(subscription, month) {
  const startMonth = toMonthKey(subscription.startDate);
  if (month < startMonth) return false;
  if (subscription.billingCycle === 'monthly') return true;
  return month.slice(5, 7) === startMonth.slice(5, 7);
}

module.exports = { isValidMonth, getMonthRange, isDueInMonth, toMonthKey };
