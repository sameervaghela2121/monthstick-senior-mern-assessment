// One-off, idempotent migration: removes duplicate renewal events (same subscription and billing
// month) so the unique index on { subscription, billingMonth } can be built. Removed events are
// archived in `renewalevents_duplicates`, never just deleted.
// Usage: MONGODB_URI=mongodb://127.0.0.1:27017/monthstick npm run migrate:dedupe -w server
const mongoose = require('mongoose');
const { RenewalEvent } = require('../src/models');

const ARCHIVE_COLLECTION = 'renewalevents_duplicates';

const time = (date) => (date ? new Date(date).getTime() : Infinity);

// Best first: charged (earliest chargedAt), then most attempts, then oldest.
function compareEvents(a, b) {
  const aCharged = a.status === 'charged';
  const bCharged = b.status === 'charged';
  if (aCharged !== bCharged) return aCharged ? -1 : 1;
  if (aCharged && time(a.chargedAt) !== time(b.chargedAt)) return time(a.chargedAt) - time(b.chargedAt);
  if ((a.attempts || 0) !== (b.attempts || 0)) return (b.attempts || 0) - (a.attempts || 0);
  if (time(a.createdAt) !== time(b.createdAt)) return time(a.createdAt) - time(b.createdAt);
  return String(a._id).localeCompare(String(b._id));
}

async function dedupeRenewalEvents({ log = console.log } = {}) {
  const groups = await RenewalEvent.aggregate([
    { $group: { _id: { subscription: '$subscription', billingMonth: '$billingMonth' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  const archive = mongoose.connection.collection(ARCHIVE_COLLECTION);
  const chargedDuplicates = [];
  let removed = 0;

  for (const group of groups) {
    const events = await RenewalEvent.find({ _id: { $in: group.ids } }).lean();
    const [kept, ...losers] = events.sort(compareEvents);
    if (losers.length === 0) continue;

    const archivedAt = new Date();
    // Upsert by _id so a rerun after a partial failure does not hit duplicate-key errors.
    await archive.bulkWrite(
      losers.map((event) => ({
        replaceOne: { filter: { _id: event._id }, replacement: { ...event, keptId: kept._id, archivedAt }, upsert: true },
      })),
    );
    const result = await RenewalEvent.deleteMany({ _id: { $in: losers.map((event) => event._id) } });
    removed += result.deletedCount;

    for (const event of losers.filter((e) => e.status === 'charged')) {
      chargedDuplicates.push({
        id: String(event._id),
        keptId: String(kept._id),
        subscription: String(event.subscription),
        billingMonth: event.billingMonth,
        amount: event.amount,
      });
    }
  }

  log(`[dedupe] ${groups.length} duplicate group(s), removed ${removed} event(s), archived in ${ARCHIVE_COLLECTION}.`);
  if (chargedDuplicates.length > 0) {
    log(`[dedupe] WARNING: ${chargedDuplicates.length} removed event(s) were charged: possible double charges, refer to finance for refund:`);
    for (const d of chargedDuplicates) {
      log(`[dedupe]   event ${d.id} (kept ${d.keptId}) subscription ${d.subscription} ${d.billingMonth} amount ${d.amount}`);
    }
  }

  return { groups: groups.length, removed, chargedDuplicates };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required.');
    process.exit(1);
  }
  mongoose.set('autoIndex', false);
  await mongoose.connect(uri);
  try {
    await dedupeRenewalEvents();
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { dedupeRenewalEvents };
