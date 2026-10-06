export function currentMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

export function monthOptions(anchorMonth, before = 3, after = 3) {
  const options = [];
  for (let offset = -before; offset <= after; offset++) {
    options.push(shiftMonth(anchorMonth, offset));
  }
  return options;
}

export function formatMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatAmount(amount, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}
