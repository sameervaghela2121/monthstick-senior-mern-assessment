// Runs async tasks with at most `max` in flight; the rest wait their turn in order.
// Returns a function that takes a task and resolves or rejects with that task's result.
function createLimiter(max) {
  let active = 0;
  const waiting = [];

  function startNext() {
    if (active >= max || waiting.length === 0) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        startNext();
      });
  }

  return function limit(task) {
    return new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      startNext();
    });
  };
}

module.exports = { createLimiter };
