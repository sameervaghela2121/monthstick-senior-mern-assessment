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

// At most one renewal event per subscription per billing month, enforced by MongoDB itself so that retries,
// double-clicks and concurrent runs (even across API instances) cannot create duplicates.
renewalEventSchema.index({ subscription: 1, billingMonth: 1 }, { unique: true });

// Serves the history query: equality on billingMonth, then sorted by createdAt (_id breaks ties deterministically,
// since events created in one run usually share the same createdAt).
renewalEventSchema.index({ billingMonth: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
