import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import * as api from '../src/api.js';

vi.mock('../src/api.js', () => ({
  fetchRenewalHistory: vi.fn(),
  fetchSummary: vi.fn(),
  runRenewals: vi.fn(),
  retryFailedCharges: vi.fn(),
}));

function historyFor(month, names, { page = 1, totalPages = 1 } = {}) {
  return {
    month,
    count: names.length,
    page,
    pageSize: 25,
    totalPages,
    events: names.map((name, i) => ({
      id: `${month}-${page}-${i}`,
      billingMonth: month,
      amount: 1000,
      currency: 'USD',
      status: 'scheduled',
      attempts: 0,
      failureReason: null,
      chargedAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      subscription: { id: `sub-${name}`, name, plan: 'Standard', billingCycle: 'monthly' },
    })),
  };
}

function summaryFor(month, total = 0) {
  return {
    month,
    eventCount: 0,
    subtotal: total,
    tax: 0,
    total,
    byStatus: { scheduled: 0, charged: 0, failed: 0 },
  };
}

const pageRequested = (call) => JSON.stringify(call.slice(1)).match(/"page":(\d+)/)?.[1];

describe('App', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.fetchSummary.mockImplementation(async (month) => summaryFor(month, 12345));
  });

  test('shows renewal history and the revenue summary for the initial month', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', ['Netflix', 'Figma']));

    render(<App initialMonth="2026-10" />);

    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Figma')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeInTheDocument();
    expect(api.fetchRenewalHistory.mock.calls[0][0]).toBe('2026-10');
    expect(await screen.findByTestId('summary-total')).toHaveTextContent('$123.45');
  });

  test('loads history for a newly selected month', async () => {
    api.fetchRenewalHistory.mockImplementation(async (month) =>
      historyFor(month, month === '2026-11' ? ['Spotify'] : ['Netflix']),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText('Netflix');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    expect(await screen.findByText('Spotify')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /November 2026/ })).toBeInTheDocument();
  });

  test('requests the next page of history', async () => {
    api.fetchRenewalHistory.mockImplementation(async (month, ...rest) => {
      const page = Number(pageRequested([month, ...rest]) ?? 1);
      return historyFor(month, [`Customer ${page}`], { page, totalPages: 3 });
    });
    const user = userEvent.setup();

    render(<App initialMonth="2026-09" />);
    await screen.findByText('Customer 1');

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Customer 2')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  test('running renewals shows a summary and refreshes the history', async () => {
    api.fetchRenewalHistory
      .mockResolvedValueOnce(historyFor('2026-10', []))
      .mockResolvedValue(historyFor('2026-10', ['Netflix']));
    api.runRenewals.mockResolvedValue({ month: '2026-10', dueCount: 1, createdCount: 1 });
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    expect(await screen.findByText(/No renewal events/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run renewals' }));

    expect(api.runRenewals).toHaveBeenCalledWith('2026-10');
    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText(/1 created/)).toBeInTheDocument();
  });

  test('retrying failed charges shows the result', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-09', ['Netflix']));
    api.retryFailedCharges.mockResolvedValue({ month: '2026-09', retried: 3, charged: 2, failed: 1 });
    const user = userEvent.setup();

    render(<App initialMonth="2026-09" />);
    await screen.findByText('Netflix');

    await user.click(screen.getByRole('button', { name: 'Retry failed charges' }));

    expect(api.retryFailedCharges).toHaveBeenCalledWith('2026-09');
    expect(await screen.findByText(/Retried 3 failed charges: 2 charged, 1 still failed/)).toBeInTheDocument();
  });

  test('shows an error when running renewals fails', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', []));
    api.runRenewals.mockRejectedValue(new Error('Renewal service unavailable'));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText(/No renewal events/);

    await user.click(screen.getByRole('button', { name: 'Run renewals' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Renewal service unavailable');
  });
});
