const { Subscription, RenewalEvent } = require('../src/models');

// All dates are UTC. Due in 2026-10: Netflix, Figma (yearly, Oct anniversary), GitHub Copilot, Canva.
// Due in 2026-11: Netflix, Notion (yearly, Nov anniversary), Spotify (starts Nov), GitHub Copilot, Canva.
// Never due: Gold's Gym (paused), Adobe Creative Cloud (cancelled).
const SUBSCRIPTIONS = [
  { name: 'Netflix', plan: 'Premium', amount: 2299, billingCycle: 'monthly', status: 'active', startDate: '2025-01-15T00:00:00Z' },
  { name: 'Figma', plan: 'Professional', amount: 14400, billingCycle: 'yearly', status: 'active', startDate: '2024-10-03T00:00:00Z' },
  { name: 'Notion', plan: 'Plus', amount: 9600, billingCycle: 'yearly', status: 'active', startDate: '2025-11-20T00:00:00Z' },
  { name: "Gold's Gym", plan: 'Standard', amount: 4500, billingCycle: 'monthly', status: 'paused', startDate: '2025-06-01T00:00:00Z' },
  { name: 'Spotify', plan: 'Family', amount: 1999, billingCycle: 'monthly', status: 'active', startDate: '2026-11-01T00:00:00Z' },
  { name: 'Adobe Creative Cloud', plan: 'All Apps', amount: 5999, billingCycle: 'monthly', status: 'cancelled', startDate: '2024-03-12T00:00:00Z' },
  { name: 'GitHub Copilot', plan: 'Individual', amount: 1000, billingCycle: 'monthly', status: 'active', startDate: '2026-02-10T00:00:00Z' },
  { name: 'Canva', plan: 'Pro', amount: 1059, billingCycle: 'monthly', status: 'active', startDate: '2026-10-31T21:00:00Z' },
];

async function seedSubscriptions() {
  return Subscription.insertMany(SUBSCRIPTIONS.map((s) => ({ ...s, startDate: new Date(s.startDate) })));
}

async function seedDatabase({ large = false } = {}) {
  const subscriptions = await seedSubscriptions();

  // Snapshot of production history for September and August. It includes the duplicate events that
  // production really contains today (Netflix was renewed twice in both months).
  const byName = Object.fromEntries(subscriptions.map((s) => [s.name, s]));
  const charged = (name, month, day) => ({
    subscription: byName[name]._id,
    billingMonth: month,
    amount: byName[name].amount,
    currency: 'USD',
    status: 'charged',
    attempts: 1,
    chargedAt: new Date(`${month}-${day}T09:00:00Z`),
  });
  await RenewalEvent.insertMany([
    charged('Netflix', '2026-08', '15'),
    charged('Netflix', '2026-08', '15'),
    charged('GitHub Copilot', '2026-08', '10'),
    charged('Netflix', '2026-09', '16'),
  ]);
  await RenewalEvent.insertMany([
    {
      subscription: byName.Netflix._id,
      billingMonth: '2026-09',
      amount: byName.Netflix.amount,
      currency: 'USD',
      status: 'charged',
      attempts: 1,
      chargedAt: new Date('2026-09-15T09:00:00Z'),
    },
    {
      subscription: byName['GitHub Copilot']._id,
      billingMonth: '2026-09',
      amount: byName['GitHub Copilot'].amount,
      currency: 'USD',
      status: 'failed',
      attempts: 1,
      failureReason: 'card_declined',
    },
  ]);

  if (large) await seedLargeDataset();
}

// Large fixture: 2,000 extra subscriptions with September history (about 10% failed), to make the
// history endpoint's performance, pagination and the retry job observable.
async function seedLargeDataset(size = 2000) {
  const docs = Array.from({ length: size }, (_, i) => ({
    name: `Customer Plan #${String(i + 1).padStart(4, '0')}`,
    plan: 'Team',
    amount: 500 + (i % 50) * 107,
    billingCycle: 'monthly',
    status: i % 10 === 0 ? 'paused' : 'active',
    startDate: new Date('2026-01-01T00:00:00Z'),
  }));
  const subscriptions = await Subscription.insertMany(docs);
  await RenewalEvent.insertMany(
    subscriptions
      .filter((s) => s.status === 'active')
      .map((s, i) => {
        const failed = i % 10 === 3;
        return {
          subscription: s._id,
          billingMonth: '2026-09',
          amount: s.amount,
          currency: s.currency,
          status: failed ? 'failed' : 'charged',
          attempts: 1,
          failureReason: failed ? 'card_declined' : undefined,
          chargedAt: failed ? undefined : new Date('2026-09-15T09:00:00Z'),
        };
      }),
  );
}

module.exports = { SUBSCRIPTIONS, seedSubscriptions, seedDatabase, seedLargeDataset };
