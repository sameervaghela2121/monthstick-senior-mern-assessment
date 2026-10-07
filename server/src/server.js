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
  await ensureIndexes();

  createApp().listen(PORT, () => {
    console.log(`MonthStick API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Error during startup:", err);
  process.exit(1);
});
