// Billing months are UTC (business rule 1). Everything here uses the UTC date APIs so the result
// does not depend on the timezone of the machine the server runs on.

function getMonthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
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

module.exports = { getMonthRange, isDueInMonth, toMonthKey };
