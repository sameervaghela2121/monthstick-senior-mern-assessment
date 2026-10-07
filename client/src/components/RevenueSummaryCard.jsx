import { formatAmount } from '../utils/months.js';

export default function RevenueSummaryCard({ summary }) {
  if (!summary) return null;
  return (
    <section className="summary-card" aria-label="Revenue summary">
      <div>
        <span className="summary-label">Total (incl. GST)</span>
        <strong data-testid="summary-total">{formatAmount(summary.total, 'USD')}</strong>
      </div>
      <div>
        <span className="summary-label">Subtotal</span>
        {formatAmount(summary.subtotal, 'USD')}
      </div>
      <div>
        <span className="summary-label">GST</span>
        {formatAmount(summary.tax, 'USD')}
      </div>
      <div>
        <span className="summary-label">Events</span>
        <span data-testid="summary-counts">
          {summary.eventCount} ({summary.byStatus.charged} charged, {summary.byStatus.failed} failed,{' '}
          {summary.byStatus.scheduled} scheduled)
        </span>
      </div>
    </section>
  );
}
