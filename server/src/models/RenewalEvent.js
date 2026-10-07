const mongoose = require('mongoose');

const renewalEventSchema = new mongoose.Schema(
  {
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    // Billing month in YYYY-MM format.
    billingMonth: { type: String, required: true },
    // Minor currency units (cents), excluding tax.
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['scheduled', 'charged', 'failed'], default: 'scheduled' },
    // Number of charge attempts recorded for this event.
    attempts: { type: Number, default: 0, min: 0 },
    failureReason: { type: String },
    chargedAt: { type: Date },
  },
  { timestamps: true },
);

// Ensure at most one renewal event per subscription per billing month
renewalEventSchema.index(
  { subscription: 1, billingMonth: 1 },
  { unique: true, name: 'uniq_subscription_billing_month' },
);

// Optimize history queries: index for filtering and sorting by month
renewalEventSchema.index(
  { billingMonth: 1, createdAt: 1 },
  { name: 'idx_billing_month_created' },
);

// Optimize filtered history queries: compound index for month, status, and sorting
renewalEventSchema.index(
  { billingMonth: 1, status: 1, createdAt: 1 },
  { name: 'idx_billing_month_status_created' },
);

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
