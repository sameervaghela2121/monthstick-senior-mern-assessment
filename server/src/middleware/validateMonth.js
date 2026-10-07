const { isValidMonth } = require('../utils/billing');
const { HttpError } = require('../utils/httpError');

// Validates `month` from the given request location ('body' or 'query') before the route touches the database.
// Rejects non-strings too, e.g. `?month=a&month=b` (an array) or `{ "month": 202610 }`.
function validateMonth(location) {
  return (req, res, next) => {
    const month = req[location]?.month;
    if (typeof month === 'string' && isValidMonth(month)) return next();

    next(
      new HttpError(400, 'INVALID_MONTH', 'month is required and must be a valid billing month in YYYY-MM format.', {
        field: 'month',
      }),
    );
  };
}

module.exports = { validateMonth };
