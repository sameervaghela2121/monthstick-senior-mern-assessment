import { useEffect, useState } from 'react';
import { fetchRenewalHistory, fetchSummary, retryFailedCharges, runRenewals } from './api.js';
import MonthPicker from './components/MonthPicker.jsx';
import RenewalHistoryTable from './components/RenewalHistoryTable.jsx';
import RevenueSummaryCard from './components/RevenueSummaryCard.jsx';
import Pagination from './components/Pagination.jsx';
import StatusFilter from './components/StatusFilter.jsx';
import RunSummary, { RetrySummary } from './components/RunSummary.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { PAGE_SIZE, SUMMARY_POLL_MS } from './config.js';
import { currentMonth, formatMonth, monthOptions } from './utils/months.js';

// Identifies one history query, so a response is only ever shown for the query that asked for it.
function historyKey(month, status, page) {
  return `${month}|${status}|${page}`;
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  // Each result is tagged with the query it belongs to: { key, data } / { key, message }.
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  const queryKey = historyKey(month, status, page);

  useEffect(() => {
    const key = historyKey(month, status, page);
    const controller = new AbortController();
    let ignore = false;

    setLoading(true);
    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE, status, signal: controller.signal })
      .then((data) => {
        if (ignore) return;
        setHistory({ key, data });
        setHistoryError(null);
        // The page can fall off the end, e.g. after a filter or data change shrinks the result.
        if (data.totalPages >= 1 && page > data.totalPages) setPage(data.totalPages);
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setHistoryError({ key, message: err.message || 'Unknown error' });
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [month, status, page, refreshCount]);

  useEffect(() => {
    let ignore = false;
    let controller = null;
    let latestRequest = 0;

    function loadSummary() {
      controller?.abort();
      controller = new AbortController();
      const requestId = ++latestRequest;
      fetchSummary(month, { signal: controller.signal })
        .then((data) => {
          if (ignore || requestId !== latestRequest) return;
          setSummary({ month, data });
          setSummaryError(null);
        })
        .catch((err) => {
          if (ignore || requestId !== latestRequest || isAbortError(err)) return;
          setSummaryError({ month, message: err.message || 'Unknown error' });
        });
    }

    loadSummary();
    const intervalId = setInterval(loadSummary, SUMMARY_POLL_MS);

    return () => {
      ignore = true;
      clearInterval(intervalId);
      controller?.abort();
    };
  }, [month, refreshCount]);

  function handleMonthChange(nextMonth) {
    setMonth(nextMonth);
    setPage(1);
  }

  function handleStatusChange(nextStatus) {
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

  // Only present results that belong to the query currently on screen. While a different
  // query loads, show the loading message instead of the previous month/filter/page's rows.
  const currentHistoryError = historyError?.key === queryKey ? historyError : null;
  const currentHistory = !currentHistoryError && history?.key === queryKey ? history.data : null;
  const showLoading = loading || (!currentHistory && !currentHistoryError);
  const currentSummaryError = summaryError?.month === month ? summaryError : null;

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker value={month} options={months} onChange={handleMonthChange} />
          <StatusFilter value={status} onChange={handleStatusChange} />
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

      {currentSummaryError && (
        <p className="summary-error">Revenue summary unavailable: {currentSummaryError.message}</p>
      )}
      <RevenueSummaryCard summary={summary?.month === month ? summary.data : null} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {currentHistoryError && (
          <ErrorBanner message={`Could not load renewal history: ${currentHistoryError.message}`} />
        )}
        {showLoading && <p className="loading">Loading renewal history…</p>}
        {currentHistory && (
          <>
            <RenewalHistoryTable events={currentHistory.events} />
            <Pagination page={page} totalPages={currentHistory.totalPages} onPageChange={setPage} />
          </>
        )}
      </section>
    </main>
  );
}
