const mongoose = require('mongoose');
const { createApp } = require('./app');
const { Subscription } = require('./models');
const { seedDatabase } = require('../scripts/seedData');

const PORT = Number(process.env.PORT) || 4000;

async function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  console.log('MONGODB_URI not set: using an in-memory MongoDB (data resets on restart).');
  return mongod.getUri('monthstick');
}

// Index creation is a startup gate: serving writes without the unique index would allow duplicates.
async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
  }
}

async function main() {
  mongoose.set('autoIndex', false);
  await mongoose.connect(await resolveMongoUri());

  if ((await Subscription.estimatedDocumentCount()) === 0) {
    await seedDatabase({ large: process.env.SEED_LARGE === 'true' });
    console.log('Seeded sample data (a snapshot of production).');
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
