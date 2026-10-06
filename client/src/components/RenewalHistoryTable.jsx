import { formatAmount } from '../utils/months.js';

export default function RenewalHistoryTable({ events }) {
  if (events.length === 0) {
    return <p className="empty">No renewal events for this month yet.</p>;
  }

  return (
    <table className="history">
      <thead>
        <tr>
          <th>Subscription</th>
          <th>Plan</th>
          <th>Cycle</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td>{event.subscription?.name ?? 'Deleted subscription'}</td>
            <td>{event.subscription?.plan}</td>
            <td>{event.subscription?.billingCycle}</td>
            <td>{formatAmount(event.amount, event.currency)}</td>
            <td>{event.status}</td>
            <td>{new Date(event.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
