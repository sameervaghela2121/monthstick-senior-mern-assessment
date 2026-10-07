import { formatAmount } from '../utils/months.js';

export default function RenewalHistoryTable({ events, status = '' }) {
  if (events.length === 0) {
    return (
      <p className="empty">
        {status ? `No renewal events with status "${status}" for this month.` : 'No renewal events for this month yet.'}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="history">
        <thead>
          <tr>
            <th>Subscription</th>
            <th>Plan</th>
            <th>Cycle</th>
            <th className="numeric">Amount</th>
            <th>Status</th>
            <th className="numeric">Attempts</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.subscription?.name ?? 'Deleted subscription'}</td>
              <td>{event.subscription?.plan}</td>
              <td>{event.subscription?.billingCycle}</td>
              <td className="numeric">{formatAmount(event.amount, event.currency)}</td>
              <td>
                <span className={`badge badge-${event.status}`}>{event.status}</span>
                {event.failureReason && <span className="failure-reason"> ({event.failureReason})</span>}
              </td>
              <td className="numeric">{event.attempts}</td>
              <td>{new Date(event.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
