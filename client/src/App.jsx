import { useEffect, useState, useRef } from 'react';
import { fetchRenewalHistory, fetchSummary, retryFailedCharges, runRenewals } from './api.js';
import MonthPicker from './components/MonthPicker.jsx';
import StatusFilter from './components/StatusFilter.jsx';
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
  const [historyMonth, setHistoryMonth] = useState(null); // Track which month the history is for
  const [historyStatus, setHistoryStatus] = useState(null); // Track which status filter the history is for
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryMonth, setSummaryMonth] = useState(null); // Track which month the summary is for
  const [refreshCount, setRefreshCount] = useState(0);
  const summaryIntervalRef = useRef(null);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Fetch renewal history when month, status, or page changes
  useEffect(() => {
    setLoading(true);
    setHistoryMonth(null); // Clear history while loading
    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE, status }).then((data) => {
      // Only update history if we're still on this month and status
      if (data.month === month && (data.status || '') === status) {
        setHistory(data);
        setHistoryMonth(month); // Mark this history as being for the current month
        setHistoryStatus(status);
      }
      setLoading(false);
    });
  }, [month, status, page, refreshCount]);

  // Fetch summary when month or refreshCount changes
  useEffect(() => {
    fetchSummary(month).then((data) => {
      setSummary(data);
      setSummaryMonth(month);
    });
  }, [month, refreshCount]);

  // Poll for summary updates with proper cleanup
  useEffect(() => {
    // Clear any existing interval
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
    }

    // Set up new interval for current month
    summaryIntervalRef.current = setInterval(() => {
      fetchSummary(month).then((data) => {
        // Only update if we're still on this month
        if (data.month === month) {
          setSummary(data);
          setSummaryMonth(month);
        }
      });
    }, SUMMARY_POLL_MS);

    // Cleanup interval when month changes
    return () => {
      if (summaryIntervalRef.current) {
        clearInterval(summaryIntervalRef.current);
      }
    };
  }, [month]);

  // Show stale data warning if history doesn't match current month
  const historyIsStale = historyMonth !== null && (historyMonth !== month || historyStatus !== status);
  const summaryIsStale = summaryMonth !== null && summaryMonth !== month;

  // Check if renewals already exist for this month (only when viewing all statuses)
  const renewalsExist = historyMonth === month && status === '' && history.count > 0;
  const renewalsMessage = renewalsExist 
    ? `Renewals already created for ${formatMonth(month)} (${history.count} events)` 
    : '';

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
          <MonthPicker value={month} options={months} onChange={(newMonth) => {
            setMonth(newMonth);
            setPage(1); // Reset to page 1 when changing months
          }} />
          <StatusFilter value={status} onChange={(newStatus) => {
            setStatus(newStatus);
            setPage(1); // Reset to page 1 when changing status filter
          }} />
          <button 
            type="button" 
            onClick={() => runAction(runRenewals, setRunSummary)}
            disabled={busy || renewalsExist}
            title={renewalsMessage || 'Run the renewal process for this month'}
          >
            Run renewals
          </button>
          <button type="button" onClick={() => runAction(retryFailedCharges, setRetryResult)}>
            Retry failed charges
          </button>
        </div>
      </header>

      <ErrorBanner message={actionError} />
      {renewalsMessage && (
        <div className="info-banner">
          ℹ️ {renewalsMessage}
        </div>
      )}
      <RunSummary summary={runSummary} />
      <RetrySummary result={retryResult} />
      {busy && <p className="loading">Working…</p>}

      {summaryIsStale ? (
        <p className="loading">Loading summary…</p>
      ) : (
        <RevenueSummaryCard summary={summary} />
      )}

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {loading && <p className="loading">Loading renewal history…</p>}
        {historyIsStale && <p className="loading">History loading…</p>}
        {!historyIsStale && <RenewalHistoryTable events={history.events} />}
        {!historyIsStale && <Pagination page={page} totalPages={history.totalPages} onPageChange={setPage} />}
      </section>
    </main>
  );
}
