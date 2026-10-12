function notFound(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}

// Turns known client errors into a safe 400 without leaking parser or database internals.
function normalize(err) {
  if (err.type === 'entity.parse.failed') return { status: 400, message: 'Invalid JSON body' };
  if (err.name === 'CastError' || err.name === 'ValidationError') {
    return { status: 400, message: 'Invalid request' };
  }
  return { status: err.status || err.statusCode || 500, message: err.message, details: err.details };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, message, details } = normalize(err);

  if (status >= 500) {
    console.error(err);
    return res.status(500).json({ error: { message: 'Internal Server Error' } });
  }

  res.status(status).json({ error: details ? { message, details } : { message } });
}

module.exports = { notFound, errorHandler };
