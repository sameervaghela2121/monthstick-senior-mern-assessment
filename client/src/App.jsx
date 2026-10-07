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

const EMPTY_HISTORY = { events: [], count: 0, totalPages: 1 };

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setHistoryError(null);

    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE, status: status || undefined })
      .then((data) => {
        if (!active) return;
        setHistory(data);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setHistory(EMPTY_HISTORY);
        setHistoryError(err.message);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [month, page, status, refreshCount]);

  useEffect(() => {
    let active = true;

    const load = () => {
      fetchSummary(month)
        .then((data) => {
          if (active) setSummary(data);
        })
        .catch(() => {
          if (active) setSummary(null);
        });
    };

    setSummary(null);
    load();
    const timer = setInterval(load, SUMMARY_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [month, refreshCount]);

  function changeMonth(nextMonth) {
    setMonth(nextMonth);
    setPage(1);
  }

  function changeStatus(nextStatus) {
    setStatus(nextStatus);
    setPage(1);
  }

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

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker value={month} options={months} onChange={changeMonth} />
          <label className="month-picker">
            Status
            <select value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">All</option>
              <option value="scheduled">Scheduled</option>
              <option value="charged">Charged</option>
              <option value="failed">Failed</option>
            </select>
          </label>
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
        {!loading && historyError && <ErrorBanner message={historyError} />}
        {!loading && !historyError && (
          <>
            <RenewalHistoryTable events={history.events} />
            <Pagination page={page} totalPages={history.totalPages} onPageChange={setPage} />
          </>
        )}
      </section>
    </main>
  );
}
