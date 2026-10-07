const { HttpError } = require('../utils/httpError');

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
  }

  // Malformed JSON body, raised by express.json() before any route runs.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
  }

  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } });
}

module.exports = { notFound, errorHandler };
