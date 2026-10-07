const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { Subscription } = require('./models');
const { seedSubscriptions, seedLargeDataset } = require('../scripts/seedData');

const PORT = Number(process.env.PORT) || 4000;

async function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const { MongoMemoryServer } = require('mongodb-memory-server');
  // Keep WiredTiger files in the workspace. Some Windows sandbox temp folders
  // deny the atomic file renames MongoDB uses during startup.
  const tempRoot = path.resolve(__dirname, '../../.mongo-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(tempRoot, 'mongo-'));
  const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
  console.log('MONGODB_URI not set: using an in-memory MongoDB (data resets on restart).');
  return mongod.getUri('monthstick');
}

// Renewal correctness depends on its unique index. Do not serve traffic if the
// database cannot enforce that constraint.
async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
  }
}

async function main() {
  mongoose.set('autoIndex', false);
  await mongoose.connect(await resolveMongoUri());

  if ((await Subscription.estimatedDocumentCount()) === 0) {
    // Production history contains legacy duplicates and cannot be inserted
    // under the unique constraint. Seed clean subscriptions locally; the user
    // can create event history by running renewals from the dashboard.
    await seedSubscriptions();
    if (process.env.SEED_LARGE === 'true') await seedLargeDataset();
    console.log('Seeded sample subscriptions.');
  }
  await ensureIndexes();

  createApp().listen(PORT, () => {
    console.log(`MonthStick API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
