import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import * as api from '../src/api.js';

// Poll every 25 ms instead of every 10 s so several polls happen within a test.
vi.mock('../src/config.js', () => ({ PAGE_SIZE: 25, SUMMARY_POLL_MS: 25 }));

vi.mock('../src/api.js', () => ({
  fetchRenewalHistory: vi.fn(),
  fetchSummary: vi.fn(),
  runRenewals: vi.fn(),
  retryFailedCharges: vi.fn(),
}));

const emptyHistory = (month) => ({ month, count: 0, page: 1, pageSize: 25, totalPages: 1, events: [] });

const summaryFor = (month, total) => ({
  month,
  eventCount: 0,
  subtotal: total,
  tax: 0,
  total,
  byStatus: { scheduled: 0, charged: 0, failed: 0 },
});

const TOTALS = { '2026-10': 11111, '2026-11': 22222 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Revenue summary polling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.fetchRenewalHistory.mockImplementation(async (month) => emptyHistory(month));
    api.fetchSummary.mockImplementation(async (month) => summaryFor(month, TOTALS[month] ?? 0));
  });

  test('keeps polling, so new payments show up without a reload', async () => {
    let total = 10000;
    api.fetchSummary.mockImplementation(async (month) => summaryFor(month, total));

    render(<App initialMonth="2026-10" />);
    expect(await screen.findByTestId('summary-total')).toHaveTextContent('$100.00');

    total = 25000;

    await waitFor(() => expect(screen.getByTestId('summary-total')).toHaveTextContent('$250.00'));
  });

  test('after a month switch only the new month is polled and shown', async () => {
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    expect(await screen.findByTestId('summary-total')).toHaveTextContent('$111.11');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');
    await waitFor(() => expect(screen.getByTestId('summary-total')).toHaveTextContent('$222.22'));

    api.fetchSummary.mockClear();
    await waitFor(() => expect(api.fetchSummary.mock.calls.length).toBeGreaterThanOrEqual(3));

    expect(api.fetchSummary.mock.calls.map(([month]) => month)).not.toContain('2026-10');
    expect(screen.getByTestId('summary-total')).toHaveTextContent('$222.22');
  });

  test("a slow response for the previous month never replaces the current month's numbers", async () => {
    let releaseOctober;
    const october = new Promise((resolve) => {
      releaseOctober = () => resolve(summaryFor('2026-10', TOTALS['2026-10']));
    });
    api.fetchSummary.mockImplementation((month) =>
      month === '2026-10' ? october : Promise.resolve(summaryFor(month, TOTALS[month])),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');
    await waitFor(() => expect(screen.getByTestId('summary-total')).toHaveTextContent('$222.22'));

    await act(async () => {
      releaseOctober();
    });

    expect(screen.getByTestId('summary-total')).toHaveTextContent('$222.22');
  });

  test("does not show the previous month's numbers while the new month is loading", async () => {
    api.fetchSummary.mockImplementation((month) =>
      month === '2026-11' ? new Promise(() => {}) : Promise.resolve(summaryFor(month, TOTALS[month])),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    expect(await screen.findByTestId('summary-total')).toHaveTextContent('$111.11');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    expect(screen.queryByTestId('summary-total')).not.toBeInTheDocument();
  });

  test('a failed refresh keeps the last numbers and says so', async () => {
    render(<App initialMonth="2026-10" />);
    expect(await screen.findByTestId('summary-total')).toHaveTextContent('$111.11');

    api.fetchSummary.mockRejectedValue(new Error('Summary service unavailable'));

    expect(await screen.findByText(/Summary service unavailable/)).toBeInTheDocument();
    expect(screen.getByTestId('summary-total')).toHaveTextContent('$111.11');
  });

  test('stops polling when the dashboard is closed', async () => {
    const { unmount } = render(<App initialMonth="2026-10" />);
    await screen.findByTestId('summary-total');

    unmount();
    api.fetchSummary.mockClear();
    await sleep(120);

    expect(api.fetchSummary).not.toHaveBeenCalled();
  });
});
