const mongoose = require('mongoose');

const renewalEventSchema = new mongoose.Schema(
  {
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    // Billing month in YYYY-MM format.
    billingMonth: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['scheduled', 'charged', 'failed'], default: 'scheduled' },
  },
  { timestamps: true },
);

// Enforce unique renewal events per subscription per month
renewalEventSchema.index({ subscription: 1, billingMonth: 1 }, { unique: true });

// Optimize history retrieval queries by month, sorted by creation date
renewalEventSchema.index({ billingMonth: 1, createdAt: 1 });

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
