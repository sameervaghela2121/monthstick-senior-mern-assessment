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

async function main() {
  await mongoose.connect(await resolveMongoUri());

  if ((await Subscription.estimatedDocumentCount()) === 0) {
    await seedDatabase({ large: process.env.SEED_LARGE === 'true' });
    console.log('Seeded sample data.');
  }

  createApp().listen(PORT, () => {
    console.log(`MonthStick API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
