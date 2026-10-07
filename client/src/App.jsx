import { useEffect, useRef, useState } from 'react';
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
  const [historyError, setHistoryError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const historyRequestId = useRef(0);
  const summaryRequestId = useRef(0);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    const requestId = ++historyRequestId.current;
    const controller = new AbortController();
    setHistory({ events: [], count: 0, totalPages: 1 });
    setLoading(true);
    setHistoryError(null);

    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE, status, signal: controller.signal })
      .then((data) => {
        if (requestId !== historyRequestId.current) return;
        setHistory(data);
      })
      .catch((err) => {
        if (requestId !== historyRequestId.current || err.name === 'AbortError') return;
        setHistory({ events: [], count: 0, totalPages: 1 });
        setHistoryError(err.message);
      })
      .finally(() => {
        if (requestId === historyRequestId.current) setLoading(false);
      });

    return () => controller.abort();
  }, [month, page, status, refreshCount]);

  useEffect(() => {
    let controller;
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(true);

    const loadSummary = () => {
      controller?.abort();
      controller = new AbortController();
      const requestId = ++summaryRequestId.current;
      fetchSummary(month, { signal: controller.signal })
        .then((data) => {
          if (requestId !== summaryRequestId.current) return;
          setSummary(data);
          setSummaryError(null);
        })
        .catch((err) => {
          if (requestId !== summaryRequestId.current || err.name === 'AbortError') return;
          setSummaryError(err.message);
        })
        .finally(() => {
          if (requestId === summaryRequestId.current) setSummaryLoading(false);
        });
    };

    loadSummary();
    const poll = setInterval(loadSummary, SUMMARY_POLL_MS);
    return () => {
      ++summaryRequestId.current;
      controller?.abort();
      clearInterval(poll);
    };
  }, [month, refreshCount]);

  function changeMonth(nextMonth) {
    setPage(1);
    setMonth(nextMonth);
  }

  function changeStatus(nextStatus) {
    setPage(1);
    setStatus(nextStatus);
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
          <label className="status-filter">
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

      <ErrorBanner message={actionError || historyError || summaryError} />
      <RunSummary summary={runSummary} />
      <RetrySummary result={retryResult} />
      {busy && <p className="loading">Working…</p>}

      {summaryLoading && <p className="loading">Loading revenue summary…</p>}
      <RevenueSummaryCard summary={summary} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {loading && <p className="loading">Loading renewal history…</p>}
        {!loading && !historyError && <RenewalHistoryTable events={history.events} />}
        <Pagination page={page} totalPages={history.totalPages} onPageChange={setPage} />
      </section>
    </main>
  );
}
