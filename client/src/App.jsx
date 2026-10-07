import { useEffect, useState } from 'react';
import { fetchRenewalHistory, fetchSummary, retryFailedCharges, runRenewals } from './api.js';
import MonthPicker from './components/MonthPicker.jsx';
import RenewalHistoryTable from './components/RenewalHistoryTable.jsx';
import RevenueSummaryCard from './components/RevenueSummaryCard.jsx';
import Pagination from './components/Pagination.jsx';
import RunSummary, { RetrySummary } from './components/RunSummary.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { PAGE_SIZE, SUMMARY_POLL_MS } from './config.js';
import { currentMonth, formatMonth, monthOptions } from './utils/months.js';

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState({ events: [], count: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    setLoading(true);

    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE }, controller.signal)
      .then((data) => {
        if (!ignore) {
          setHistory(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!ignore && err.name !== 'AbortError') {
          setLoading(false);
          setHistory({ events: [], count: 0, totalPages: 1 });
        }
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [month, page, refreshCount]);

  useEffect(() => {
    let ignore = false;

    const updateSummary = () => {
      fetchSummary(month).then(data => {
        if (!ignore) setSummary(data);
      });
    };

    updateSummary();
    const interval = setInterval(updateSummary, SUMMARY_POLL_MS);

    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [month, refreshCount]);

  async function runAction(action, onResult) {
    setBusy(true);
    setActionError(null);
    try {
      onResult(await action(month));
      setRefreshCount((count) => count + 1);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const handleMonthChange = (newMonth) => {
    setMonth(newMonth);
    setPage(1);
  }

  function handleStatusChange(e) {
    setStatus(e.target.value);
    setPage(1);
  }

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker value={month} options={months} onChange={handleMonthChange} />
          <select id="status-filter" value={status} onChange={handleStatusChange}>
            <option value="">All</option>
            <option value="scheduled">Scheduled</option>
            <option value="charged">Charged</option>
            <option value="failed">Failed</option>
          </select>
          <button type="button" onClick={() => runAction(runRenewals, setRunSummary)}>
            Run renewals
          </button>
          <button type="button" onClick={() => runAction(retryFailedCharges, setRetryResult)}>
            Retry failed charges
          </button>
        </div>
      </header>

      <ErrorBanner message={actionError} />
      <RunSummary summary={runSummary} />
      <RetrySummary result={retryResult} />
      {busy && <p className="loading">Working…</p>}

      <RevenueSummaryCard summary={summary} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {loading && <p className="loading">Loading renewal history…</p>}
        <RenewalHistoryTable events={history.events} />
        <Pagination page={page} totalPages={history.totalPages} onPageChange={setPage} />
      </section>
    </main>
  );
}
