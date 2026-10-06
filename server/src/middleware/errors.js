function notFound(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(err);
    return res.status(500).json({ error: { message: 'Internal Server Error' } });
  }

  res.status(status).json({ error: { message: err.message } });
}

module.exports = { notFound, errorHandler };
