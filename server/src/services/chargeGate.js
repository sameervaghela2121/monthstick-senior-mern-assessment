const { MAX_CONCURRENT_CHARGES } = require('./paymentGateway');

// The gateway rejects more than MAX_CONCURRENT_CHARGES in-flight calls.
// One shared gate covers overlapping retry requests in this process.
function createChargeGate(limit) {
  let active = 0;
  const waiting = [];

  function acquire() {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiting.push(resolve);
    });
  }

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  return async function withChargeSlot(task) {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

const withChargeSlot = createChargeGate(MAX_CONCURRENT_CHARGES);

module.exports = { withChargeSlot, createChargeGate };
