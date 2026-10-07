const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    plan: { type: String, trim: true },
    // Minor currency units (cents).
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    billingCycle: { type: String, enum: ['monthly', 'yearly'], required: true },
    status: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
    startDate: { type: Date, required: true },
  },
  { timestamps: true },
);

// Serves the renewal run's candidate query: { status: 'active', startDate: { $lt: <end of month> } }.
subscriptionSchema.index({ status: 1, startDate: 1 });

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
