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
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [historyError, setHistoryError] = useState(null);
  const [summaryError, setSummaryError] = useState(null);

  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [retryResult, setRetryResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  const currentHistory = history
    && history.month === month
    && history.page === page
    && history.statusFilter === statusFilter
    ? history
    : null;
  const currentHistoryError = historyError
    && historyError.month === month
    && historyError.page === page
    && historyError.statusFilter === statusFilter
    ? historyError.message
    : null;
  const currentSummary = summary?.month === month ? summary : null;
  const currentSummaryError = summaryError?.month === month ? summaryError.message : null;
  const historyLoading = loading || (!currentHistory && !currentHistoryError);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setHistory(null);
    setLoading(true);
    setHistoryError(null);
    fetchRenewalHistory(month, {
      page,
      pageSize: PAGE_SIZE,
      status: statusFilter,
      signal: controller.signal,
    })
      .then((data) => {
        if (current) {
          setHistory({ ...data, statusFilter });
          if (data.page !== page) setPage(data.page);
        }
      })
      .catch((error) => {
        if (current && error.name !== 'AbortError') {
          setHistoryError({ month, page, statusFilter, message: error.message });
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [month, page, statusFilter, refreshCount]);

  useEffect(() => {
    let current = true;
    let requestSequence = 0;
    let controller;
    setSummary(null);
    setSummaryError(null);

    function loadSummary() {
      const sequence = ++requestSequence;
      controller?.abort();
      controller = new AbortController();
      fetchSummary(month, { signal: controller.signal })
        .then((data) => {
          if (current && sequence === requestSequence) {
            setSummary(data);
            setSummaryError(null);
          }
        })
        .catch((error) => {
          if (current && sequence === requestSequence && error.name !== 'AbortError') {
            setSummaryError({ month, message: error.message });
          }
        });
    }

    loadSummary();
    const interval = setInterval(loadSummary, SUMMARY_POLL_MS);
    return () => {
      current = false;
      clearInterval(interval);
      controller?.abort();
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

  return (
    <main className="app">
      <header>
        <h1>MonthStick Renewal Console</h1>
        <div className="toolbar">
          <MonthPicker
            value={month}
            options={months}
            onChange={(value) => {
              setPage(1);
              setMonth(value);
            }}
          />
          <label className="status-filter">
            Status
            <select
              value={statusFilter}
              onChange={(event) => {
                setPage(1);
                setStatusFilter(event.target.value);
              }}
            >
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

      <ErrorBanner message={actionError || currentHistoryError || currentSummaryError} />
      <RunSummary summary={runSummary} />
      <RetrySummary result={retryResult} />
      {busy && <p className="loading">Working…</p>}

      <RevenueSummaryCard summary={currentSummary} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Renewal history: {formatMonth(month)}</h2>
        {historyLoading && <p className="loading">Loading renewal history…</p>}
        {!historyLoading && !currentHistoryError && (
          <RenewalHistoryTable events={currentHistory?.events ?? []} />
        )}
        {currentHistory && !historyLoading && (
          <Pagination
            page={currentHistory.page}
            totalPages={currentHistory.totalPages}
            onPageChange={setPage}
          />
        )}
      </section>
    </main>
  );
}
