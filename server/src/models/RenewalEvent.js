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

// At most one renewal event per subscription and billing month, enforced by the database.
renewalEventSchema.index({ subscription: 1, billingMonth: 1 }, { unique: true });
// History for a month in a stable order (createdAt, then _id as a tie-breaker) for paging.
renewalEventSchema.index({ billingMonth: 1, createdAt: 1, _id: 1 });
// History filtered by status, and the retry-failed lookup.
renewalEventSchema.index({ billingMonth: 1, status: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
