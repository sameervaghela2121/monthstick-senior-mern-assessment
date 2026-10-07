// An error that is safe to show to API clients. Anything else reaching the error handler is treated as an
// internal failure and replaced by a generic 500, so stack traces and database details never leak.
class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = { HttpError };
