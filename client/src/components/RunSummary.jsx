import { formatMonth } from '../utils/months.js';

export default function RunSummary({ summary }) {
  if (!summary) return null;
  return (
    <p className="run-summary" role="status">
      Renewal run for {formatMonth(summary.month)}: {summary.createdCount} created,
      {' '}{summary.alreadyExistedCount ?? 0} already existed ({summary.dueCount} due).
    </p>
  );
}
