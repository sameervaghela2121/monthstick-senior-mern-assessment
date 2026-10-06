const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('../../src/models');

let mongod;
const commands = [];

async function startDatabase() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('monthstick-test'), { monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', (event) => commands.push(event));
  await mongoose.connection.syncIndexes();
}

async function resetDatabase() {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
  commands.length = 0;
}

async function stopDatabase() {
  await mongoose.disconnect();
  await mongod?.stop();
}

module.exports = { startDatabase, resetDatabase, stopDatabase, commands };
