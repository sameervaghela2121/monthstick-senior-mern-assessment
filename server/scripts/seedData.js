const { Subscription, RenewalEvent } = require('../src/models');

// Due in 2026-10: Netflix, Figma (yearly, Oct anniversary), GitHub Copilot.
// Due in 2026-11: Netflix, Notion (yearly, Nov anniversary), Spotify (starts Nov), GitHub Copilot.
// Never due: Gold's Gym (paused), Adobe Creative Cloud (cancelled).
const SUBSCRIPTIONS = [
  { name: 'Netflix', plan: 'Premium', amount: 2299, billingCycle: 'monthly', status: 'active', startDate: '2025-01-15' },
  { name: 'Figma', plan: 'Professional', amount: 14400, billingCycle: 'yearly', status: 'active', startDate: '2024-10-03' },
  { name: 'Notion', plan: 'Plus', amount: 9600, billingCycle: 'yearly', status: 'active', startDate: '2025-11-20' },
  { name: "Gold's Gym", plan: 'Standard', amount: 4500, billingCycle: 'monthly', status: 'paused', startDate: '2025-06-01' },
  { name: 'Spotify', plan: 'Family', amount: 1999, billingCycle: 'monthly', status: 'active', startDate: '2026-11-01' },
  { name: 'Adobe Creative Cloud', plan: 'All Apps', amount: 5999, billingCycle: 'monthly', status: 'cancelled', startDate: '2024-03-12' },
  { name: 'GitHub Copilot', plan: 'Individual', amount: 1000, billingCycle: 'monthly', status: 'active', startDate: '2026-02-10' },
];

async function seedSubscriptions() {
  return Subscription.insertMany(
    SUBSCRIPTIONS.map((s) => ({ ...s, startDate: new Date(`${s.startDate}T00:00:00Z`) })),
  );
}

async function seedDatabase({ large = false } = {}) {
  const subscriptions = await seedSubscriptions();

  // Some September history so the dashboard is not empty on first load.
  const september = subscriptions.filter((s) => ['Netflix', 'GitHub Copilot'].includes(s.name));
  await RenewalEvent.insertMany(
    september.map((s) => ({
      subscription: s._id,
      billingMonth: '2026-09',
      amount: s.amount,
      currency: s.currency,
      status: 'charged',
    })),
  );

  if (large) await seedLargeDataset();
}

// Large fixture: 2,000 extra subscriptions with September history, to make the history endpoint's performance observable.
async function seedLargeDataset(size = 2000) {
  const docs = Array.from({ length: size }, (_, i) => ({
    name: `Customer Plan #${String(i + 1).padStart(4, '0')}`,
    plan: 'Team',
    amount: 500 + (i % 50) * 100,
    billingCycle: 'monthly',
    status: i % 10 === 0 ? 'paused' : 'active',
    startDate: new Date('2026-01-01T00:00:00Z'),
  }));
  const subscriptions = await Subscription.insertMany(docs);
  await RenewalEvent.insertMany(
    subscriptions
      .filter((s) => s.status === 'active')
      .map((s) => ({
        subscription: s._id,
        billingMonth: '2026-09',
        amount: s.amount,
        currency: s.currency,
        status: 'charged',
      })),
  );
}

module.exports = { SUBSCRIPTIONS, seedSubscriptions, seedDatabase, seedLargeDataset };
