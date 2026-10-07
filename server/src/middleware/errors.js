function notFound(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // express.json() reports a malformed body with the JSON parser's own message; keep that internal.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Request body must be valid JSON' } });
  }

  const status = err.status || err.statusCode || 500;

  // Only errors raised for the client (`expose`) are described to it. Anything else stays generic,
  // including database or payment-provider errors that happen to carry a status code.
  if (status >= 500 || !err.expose) {
    console.error(err);
    return res.status(500).json({ error: { message: 'Internal Server Error' } });
  }

  const error = { message: err.message };
  if (err.details) error.details = err.details;
  res.status(status).json({ error });
}

module.exports = { notFound, errorHandler };
