import { useEffect, useState } from 'react';
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

const selectionKey = (month, status, page) => `${month}|${status}|${page}`;
const NOTHING = { data: null, error: null };

export default function App({ initialMonth = currentMonth() }) {
  const [months] = useState(() => monthOptions(initialMonth));
  const [month, setMonth] = useState(initialMonth);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [refreshCount, setRefreshCount] = useState(0);

  // Every result is stored together with the selection it was requested for, and is only rendered
  // while that is still the current selection. Rows or totals from another month, filter or page
  // can therefore never be shown as current.
  const [history, setHistory] = useState({ selection: null, ...NOTHING });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [summary, setSummary] = useState({ month: null, ...NOTHING });

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    // The cleanup sets this when the selection changes before the response arrives, so a slow
    // response for an earlier selection is dropped instead of overwriting newer data.
    let ignore = false;
    const selection = selectionKey(month, status, page);
    setHistoryLoading(true);

    fetchRenewalHistory(month, { page, pageSize: PAGE_SIZE, status })
      .then((data) => {
        if (ignore) return;
        // The page can stop existing, for example after the last failed charges were retried.
        if (data.events.length === 0 && page > data.totalPages) {
          setPage(data.totalPages);
          return;
        }
        setHistory({ selection, data, error: null });
        setHistoryLoading(false);
      })
      .catch((err) => {
        if (ignore) return;
        setHistory({ selection, data: null, error: err.message });
        setHistoryLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [month, status, page, refreshCount]);

  useEffect(() => {
    let ignore = false;

    function load() {
      fetchSummary(month)
        .then((data) => {
          if (!ignore) setSummary({ month, data, error: null });
        })
        .catch((err) => {
          if (ignore) return;
          // Keep this month's last good numbers on screen and say that the refresh failed.
          setSummary((previous) => ({
            month,
            data: previous.month === month ? previous.data : null,
            error: err.message,
          }));
        });
    }

    load();
    // Poll so charges recorded by webhooks show up without a reload. The cleanup stops this month's
    // timer before the next month's starts; without it every month ever selected kept polling.
    const timer = setInterval(load, SUMMARY_POLL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [month, refreshCount]);

  // Changing the month or the filter starts again from page 1. Both updates happen in the same
  // event, so React renders once and a single request is sent.
  function changeMonth(nextMonth) {
    setMonth(nextMonth);
    setPage(1);
  }

  function changeStatus(nextStatus) {
    setStatus(nextStatus);
    setPage(1);
  }

  const refresh = () => setRefreshCount((count) => count + 1);

  async function runAction(action, onResult) {
    setBusy(true);
    setActionError(null);
    try {
      onResult(await action(month));
      refresh();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shownHistory = history.selection === selectionKey(month, status, page) ? history : NOTHING;
  const shownSummary = summary.month === month ? summary : NOTHING;

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker value={month} options={months} onChange={changeMonth} />
          <button type="button" disabled={busy} onClick={() => runAction(runRenewals, setRunSummary)}>
            Run renewals
          </button>
          <button type="button" disabled={busy} onClick={() => runAction(retryFailedCharges, setRetryResult)}>
            Retry failed charges
          </button>
        </div>
      </header>

      <ErrorBanner message={actionError} />
      <RunSummary summary={runSummary} />
      <RetrySummary result={retryResult} />
      {busy && <p className="loading">Working…</p>}

      <RevenueSummaryCard summary={shownSummary.data} />
      {shownSummary.error && (
        <p className="summary-error" role="status">
          Revenue summary could not be refreshed: {shownSummary.error}
        </p>
      )}

      <section aria-labelledby="history-heading" aria-busy={historyLoading}>
        <div className="history-header">
          <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
          <StatusFilter value={status} onChange={changeStatus} />
        </div>
        {historyLoading && <p className="loading">Loading renewal history…</p>}
        {!historyLoading && shownHistory.error && (
          <div role="alert" className="error-banner">
            Could not load renewal history: {shownHistory.error}{' '}
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {shownHistory.data && (
          <>
            <RenewalHistoryTable events={shownHistory.data.events} status={status} />
            <Pagination page={page} totalPages={shownHistory.data.totalPages} onPageChange={setPage} />
          </>
        )}
      </section>
    </main>
  );
}
