const { RenewalEvent } = require('../models');

// charged is the invoice finance already booked, so it wins over a later failure.
const STATUS_RANK = { charged: 0, failed: 1, scheduled: 2 };

function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000 || err.code === 11001) return true;
  return err.cause?.code === 11000 || err.cause?.code === 11001;
}

function compareKeepers(a, b) {
  const byStatus = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
  if (byStatus !== 0) return byStatus;
  if (b.attempts !== a.attempts) return b.attempts - a.attempts;
  const created = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (created !== 0) return created;
  return String(a._id).localeCompare(String(b._id));
}

// The production snapshot already contains two events for the same subscription
// and month. The unique index cannot be built until one of each pair is removed.
// This keeps a single keeper and deletes the rest. It does not change the seed file.
async function collapseDuplicateRenewalEvents() {
  const groups = await RenewalEvent.aggregate([
    {
      $group: {
        _id: { subscription: '$subscription', billingMonth: '$billingMonth' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  const removed = [];
  for (const group of groups) {
    const docs = await RenewalEvent.find({ _id: { $in: group.ids } });
    docs.sort(compareKeepers);
    const [keep, ...extras] = docs;
    if (!keep || extras.length === 0) continue;

    await RenewalEvent.deleteMany({ _id: { $in: extras.map((doc) => doc._id) } });
    for (const extra of extras) {
      removed.push(String(extra._id));
      console.warn(
        `[renewals] removed duplicate ${extra._id} for subscription ${group._id.subscription} ` +
          `${group._id.billingMonth} (status ${extra.status}, attempts ${extra.attempts}); kept ${keep._id}`,
      );
    }
  }

  return removed;
}

module.exports = { collapseDuplicateRenewalEvents, isDuplicateKeyError };
