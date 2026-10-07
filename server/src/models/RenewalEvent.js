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
    // Set on every event the renewal run creates; it puts the event under the unique index below.
    // Events from before that index existed do not have it.
    uniquePerMonth: { type: Boolean },
  },
  { timestamps: true },
);

// At most one renewal event per subscription and billing month, enforced by the database.
// Production already contains duplicates from before this rule (see scripts/seedData.js), and a
// plain unique index cannot be built over them. A partial index can: it covers the events written
// by the renewal run and leaves the legacy rows, which finance still has to reconcile, untouched.
renewalEventSchema.index(
  { subscription: 1, billingMonth: 1 },
  { unique: true, partialFilterExpression: { uniquePerMonth: true } },
);

// History is read one month at a time, oldest first, with _id as a tie-breaker so that paging is
// stable. The first index serves the unfiltered list; the second serves the status filter, the
// per-status counts and the "retry failed" lookup. Both return rows already sorted.
renewalEventSchema.index({ billingMonth: 1, createdAt: 1, _id: 1 });
renewalEventSchema.index({ billingMonth: 1, status: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.models.RenewalEvent || mongoose.model('RenewalEvent', renewalEventSchema);
