// Seeds a real MongoDB instance with the production snapshot.
// Usage: MONGODB_URI=mongodb://127.0.0.1:27017/monthstick npm run seed -w server [-- --large]
const mongoose = require('mongoose');
const { Subscription, RenewalEvent } = require('../src/models');
const { seedDatabase } = require('./seedData');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required. (Without it, `npm run dev` uses an in-memory database that seeds itself.)');
    process.exit(1);
  }
  mongoose.set('autoIndex', false);
  await mongoose.connect(uri);
  await Promise.all([Subscription.deleteMany({}), RenewalEvent.deleteMany({})]);
  await seedDatabase({ large: process.argv.includes('--large') });
  console.log('Seed complete.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
