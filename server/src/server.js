const mongoose = require('mongoose');
const { createApp } = require('./app');
const { Subscription, RenewalEvent } = require('./models');
const { seedDatabase } = require('../scripts/seedData');

const PORT = Number(process.env.PORT) || 4000;

async function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  console.log('MONGODB_URI not set: using an in-memory MongoDB (data resets on restart).');
  return mongod.getUri('monthstick');
}

// Production data created by the duplicate-renewal bug already contains more than one event for
// the same (subscription, billingMonth). The unique index that prevents future duplicates cannot
// be built over that data, so we first collapse each duplicate group to a single event. This is the
// data migration that would run during rollout, before the new constraint is enforced.
// We keep the earliest-created event in each group and remove the surplus rows.
async function dedupeRenewalEvents() {
  const duplicateGroups = await RenewalEvent.aggregate([
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { subscription: '$subscription', billingMonth: '$billingMonth' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  const idsToRemove = duplicateGroups.flatMap((group) => group.ids.slice(1));
  if (idsToRemove.length > 0) {
    const { deletedCount } = await RenewalEvent.deleteMany({ _id: { $in: idsToRemove } });
    console.log(`[startup] removed ${deletedCount} duplicate renewal event(s) before building the unique index.`);
  }
}

// Indexes are built after startup data is in place, like a production deploy against existing data.
// A failed index build must not take the API down, so it is logged and startup continues.
async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    try {
      await model.createIndexes();
    } catch (err) {
      console.warn(`[startup] could not build indexes for ${model.modelName}: ${err.message}`);
    }
  }
}

async function main() {
  mongoose.set('autoIndex', false);
  await mongoose.connect(await resolveMongoUri());

  if ((await Subscription.estimatedDocumentCount()) === 0) {
    await seedDatabase({ large: process.env.SEED_LARGE === 'true' });
    console.log('Seeded sample data (a snapshot of production).');
  }
  await dedupeRenewalEvents();
  await ensureIndexes();

  createApp().listen(PORT, () => {
    console.log(`MonthStick API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
