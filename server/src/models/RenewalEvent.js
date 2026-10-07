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

renewalEventSchema.index({ subscription: 1, billingMonth: 1 }, { unique: true });

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
