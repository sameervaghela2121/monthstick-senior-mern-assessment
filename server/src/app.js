const express = require('express');
const renewalsRouter = require('./routes/renewals');
const subscriptionsRouter = require('./routes/subscriptions');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();

  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/renewals', renewalsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
