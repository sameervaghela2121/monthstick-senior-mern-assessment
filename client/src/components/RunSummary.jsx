import { formatMonth } from '../utils/months.js';

export default function RunSummary({ summary }) {
  if (!summary) return null;
  return (
    <p className="run-summary" role="status">
      Renewal run for {formatMonth(summary.month)}: {summary.createdCount} created
      {summary.alreadyExistedCount > 0
        ? `, ${summary.alreadyExistedCount} already existed`
        : ''}
      {' '}({summary.dueCount} due).
    </p>
  );
}

export function RetrySummary({ result }) {
  if (!result) return null;
  return (
    <p className="run-summary" role="status">
      Retried {result.retried} failed charge{result.retried === 1 ? '' : 's'}
      {result.charged != null && `: ${result.charged} charged, ${result.failed} still failed`}.
    </p>
  );
}
