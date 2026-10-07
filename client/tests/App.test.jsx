import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
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

// A promise the test settles by hand, to control the order in which responses arrive.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  test('disables the action buttons while an action is running', async () => {
    const pending = deferred();
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', []));
    api.runRenewals.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText(/No renewal events/);

    const runButton = screen.getByRole('button', { name: 'Run renewals' });
    await user.click(runButton);
    await user.click(runButton);

    expect(runButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry failed charges' })).toBeDisabled();
    expect(api.runRenewals).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ month: '2026-10', dueCount: 4, createdCount: 0, existingCount: 4 });
    });

    expect(runButton).toBeEnabled();
    expect(screen.getByText(/0 created/)).toHaveTextContent('4 already existed');
  });

  describe('history always belongs to the current selection', () => {
    test('ignores a slow response for a month that is no longer selected', async () => {
      const november = deferred();
      api.fetchRenewalHistory.mockImplementation((month) => {
        if (month === '2026-11') return november.promise;
        return Promise.resolve(historyFor(month, month === '2026-12' ? ['Figma'] : ['Netflix']));
      });
      const user = userEvent.setup();

      render(<App initialMonth="2026-10" />);
      await screen.findByText('Netflix');

      await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');
      await user.selectOptions(screen.getByLabelText('Billing month'), '2026-12');
      expect(await screen.findByText('Figma')).toBeInTheDocument();

      // November's response arrives after December is already on screen.
      await act(async () => {
        november.resolve(historyFor('2026-11', ['Spotify']));
      });

      expect(screen.getByText('Figma')).toBeInTheDocument();
      expect(screen.queryByText('Spotify')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /December 2026/ })).toBeInTheDocument();
    });

    test("does not show the previous month's rows while the new month is loading", async () => {
      const november = deferred();
      api.fetchRenewalHistory.mockImplementation((month) =>
        month === '2026-11' ? november.promise : Promise.resolve(historyFor(month, ['Netflix'])),
      );
      const user = userEvent.setup();

      render(<App initialMonth="2026-10" />);
      await screen.findByText('Netflix');

      await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

      expect(screen.getByText(/Loading renewal history/)).toBeInTheDocument();
      expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
      expect(screen.queryByText(/No renewal events/)).not.toBeInTheDocument();

      await act(async () => {
        november.resolve(historyFor('2026-11', ['Spotify']));
      });

      expect(screen.getByText('Spotify')).toBeInTheDocument();
      expect(screen.queryByText(/Loading renewal history/)).not.toBeInTheDocument();
    });

    test('shows an error when history cannot be loaded, then recovers on retry', async () => {
      api.fetchRenewalHistory
        .mockRejectedValueOnce(new Error('History service unavailable'))
        .mockResolvedValue(historyFor('2026-10', ['Netflix']));
      const user = userEvent.setup();

      render(<App initialMonth="2026-10" />);

      expect(await screen.findByRole('alert')).toHaveTextContent('History service unavailable');
      expect(screen.queryByText(/Loading renewal history/)).not.toBeInTheDocument();
      expect(screen.queryByText(/No renewal events/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Netflix')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    test('switching months goes back to page 1', async () => {
      api.fetchRenewalHistory.mockImplementation(async (month, options = {}) =>
        historyFor(month, [`${month} page ${options.page}`], {
          page: options.page,
          totalPages: month === '2026-09' ? 6 : 1,
        }),
      );
      const user = userEvent.setup();

      render(<App initialMonth="2026-09" />);
      await screen.findByText('2026-09 page 1');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByText('2026-09 page 2');

      await user.selectOptions(screen.getByLabelText('Billing month'), '2026-10');

      expect(await screen.findByText('2026-10 page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
      const octoberPages = api.fetchRenewalHistory.mock.calls
        .filter(([month]) => month === '2026-10')
        .map((call) => pageRequested(call));
      expect(octoberPages).toEqual(['1']);
    });

    test('returns to the last page when the current page no longer exists', async () => {
      let totalPages = 3;
      api.fetchRenewalHistory.mockImplementation(async (month, options = {}) =>
        historyFor(month, options.page > totalPages ? [] : [`Customer ${options.page}`], {
          page: options.page,
          totalPages,
        }),
      );
      api.retryFailedCharges.mockImplementation(async () => {
        totalPages = 2;
        return { month: '2026-09', retried: 5, charged: 5, failed: 0 };
      });
      const user = userEvent.setup();

      render(<App initialMonth="2026-09" />);
      await screen.findByText('Customer 1');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByText('Customer 2');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByText('Customer 3');

      await user.click(screen.getByRole('button', { name: 'Retry failed charges' }));

      expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
      expect(screen.getByText('Customer 2')).toBeInTheDocument();
    });
  });

  describe('status filter', () => {
    test('offers All, Scheduled, Charged and Failed', async () => {
      api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', ['Netflix']));

      render(<App initialMonth="2026-10" />);
      await screen.findByText('Netflix');

      const select = screen.getByLabelText('Status');
      expect(select).toHaveValue('');
      expect(within(select).getAllByRole('option').map((option) => [option.textContent, option.value])).toEqual([
        ['All', ''],
        ['Scheduled', 'scheduled'],
        ['Charged', 'charged'],
        ['Failed', 'failed'],
      ]);
    });

    test('requests the selected status and goes back to page 1', async () => {
      api.fetchRenewalHistory.mockImplementation(async (month, options = {}) =>
        historyFor(month, [`${options.status || 'all'} page ${options.page}`], {
          page: options.page,
          totalPages: 3,
        }),
      );
      const user = userEvent.setup();

      render(<App initialMonth="2026-09" />);
      await screen.findByText('all page 1');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByText('all page 2');

      await user.selectOptions(screen.getByLabelText('Status'), 'failed');

      expect(await screen.findByText('failed page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      expect(api.fetchRenewalHistory).toHaveBeenLastCalledWith(
        '2026-09',
        expect.objectContaining({ page: 1, status: 'failed' }),
      );

      await user.selectOptions(screen.getByLabelText('Status'), '');
      expect(await screen.findByText('all page 1')).toBeInTheDocument();
    });

    test('keeps the status filter when the month changes', async () => {
      api.fetchRenewalHistory.mockImplementation(async (month, options = {}) =>
        historyFor(month, [`${month} ${options.status || 'all'}`]),
      );
      const user = userEvent.setup();

      render(<App initialMonth="2026-10" />);
      await screen.findByText('2026-10 all');
      await user.selectOptions(screen.getByLabelText('Status'), 'failed');
      await screen.findByText('2026-10 failed');

      await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

      expect(await screen.findByText('2026-11 failed')).toBeInTheDocument();
      expect(screen.getByLabelText('Status')).toHaveValue('failed');
    });
  });
});
