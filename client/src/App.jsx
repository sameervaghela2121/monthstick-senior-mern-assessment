import { useState } from 'react';
import { runRenewals } from './api.js';
import MonthPicker from './components/MonthPicker.jsx';
import RenewalHistoryTable from './components/RenewalHistoryTable.jsx';
import RunSummary from './components/RunSummary.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { useRenewalHistory } from './hooks/useRenewalHistory.js';
import { currentMonth, formatMonth, monthOptions } from './utils/months.js';

function RenewalHistory({ history }) {
  const { status, events, error, reload } = history;

  if (status === 'error') {
    return <ErrorBanner message={`Could not load renewal history: ${error}`} onRetry={reload} />;
  }
  // Never fall through to the "no renewal events" empty state while we don't know the answer yet.
  if (status === 'loading' && events.length === 0) {
    return <p className="loading">Loading renewal history…</p>;
  }
  return (
    <>
      {status === 'loading' && <p className="loading">Refreshing…</p>}
      <RenewalHistoryTable events={events} />
    </>
  );
}

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const history = useRenewalHistory(month);

  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [runError, setRunError] = useState(null);

  async function handleRunRenewals() {
    setRunning(true);
    setRunError(null);
    try {
      const summary = await runRenewals(month);
      setRunSummary(summary);
      history.reload();
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker value={month} options={months} onChange={setMonth} />
          {/* Disabling avoids accidental double submits; the server stays idempotent regardless. */}
          <button type="button" onClick={handleRunRenewals} disabled={running}>
            {running ? 'Running…' : 'Run renewals'}
          </button>
        </div>
      </header>

      <ErrorBanner message={runError} />
      <RunSummary summary={runSummary} />

      <section aria-labelledby="history-heading" aria-busy={history.status === 'loading'}>
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        <RenewalHistory history={history} />
      </section>
    </main>
  );
}
