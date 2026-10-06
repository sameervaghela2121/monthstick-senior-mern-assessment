const express = require('express');
const { Subscription } = require('../models');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const subscriptions = await Subscription.find().sort({ name: 1 }).lean();
    res.json({
      subscriptions: subscriptions.map(({ _id, __v, ...rest }) => ({ id: String(_id), ...rest })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
