import { useEffect, useState } from 'react';
import { fetchRenewalHistory, runRenewals } from './api.js';
import MonthPicker from './components/MonthPicker.jsx';
import RenewalHistoryTable from './components/RenewalHistoryTable.jsx';
import RunSummary from './components/RunSummary.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { currentMonth, formatMonth, monthOptions } from './utils/months.js';

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [runError, setRunError] = useState(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setFetchError(null);
    setEvents([]);

    fetchRenewalHistory(month)
      .then((data) => {
        if (!ignore) {
          setEvents(data.events);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!ignore) {
          setFetchError(err.message);
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [month, refreshCount]);

  async function handleRunRenewals() {
    setRunning(true);
    setRunError(null);
    try {
      const summary = await runRenewals(month);
      setRunSummary(summary);
      setRefreshCount((count) => count + 1);
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
          <button type="button" onClick={handleRunRenewals}>
            {running ? 'Running…' : 'Run renewals'}
          </button>
        </div>
      </header>

      <ErrorBanner message={runError} />
      <RunSummary summary={runSummary} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        <ErrorBanner message={fetchError} />
        {loading && <p className="loading">Loading renewal history…</p>}
        {!loading && !fetchError && <RenewalHistoryTable events={events} />}
      </section>
    </main>
  );
}
