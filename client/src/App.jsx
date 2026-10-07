import { useEffect, useRef, useState } from 'react';
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
  const [historyError, setHistoryError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const historyRequestRef = useRef(0);

  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [runError, setRunError] = useState(null);

  useEffect(() => {
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    const controller = new AbortController();

    async function loadHistory() {
      setLoading(true);
      setHistoryError(null);
      setEvents([]);

      try {
        const data = await fetchRenewalHistory(month, controller.signal);
        if (requestId !== historyRequestRef.current) return;
        setEvents(data.events);
      } catch (err) {
        if (controller.signal.aborted || requestId !== historyRequestRef.current) return;
        setEvents([]);
        setHistoryError(err.message);
      } finally {
        if (requestId === historyRequestRef.current) {
          setLoading(false);
        }
      }
    }

    loadHistory();

    return () => {
      controller.abort();
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
      <ErrorBanner message={historyError} />
      <RunSummary summary={runSummary} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {loading && <p className="loading">Loading renewal history…</p>}
        {!loading && historyError && <p className="empty">Unable to load renewal history for this month.</p>}
        <RenewalHistoryTable events={events} />
      </section>
    </main>
  );
}
