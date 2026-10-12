import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import * as api from '../src/api.js';
import { SUMMARY_POLL_MS } from '../src/config.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  test('a late October response does not replace November history', async () => {
    const october = deferred();
    api.fetchRenewalHistory.mockImplementation((month) =>
      month === '2026-10' ? october.promise : Promise.resolve(historyFor(month, ['Spotify'])),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    expect(screen.getByText('Loading renewal history…')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');
    expect(await screen.findByText('Spotify')).toBeInTheDocument();

    await act(async () => {
      october.resolve(historyFor('2026-10', ['Netflix']));
      await october.promise;
    });

    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
    expect(screen.getByText('Spotify')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /November 2026/ })).toBeInTheDocument();
  });

  test('does not show the previous month while the new month is loading', async () => {
    const november = deferred();
    api.fetchRenewalHistory.mockImplementation((month) =>
      month === '2026-11' ? november.promise : Promise.resolve(historyFor(month, ['Netflix'])),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText('Netflix');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
    expect(screen.getByText('Loading renewal history…')).toBeInTheDocument();

    await act(async () => {
      november.resolve(historyFor('2026-11', ['Spotify']));
      await november.promise;
    });
    expect(screen.getByText('Spotify')).toBeInTheDocument();
    expect(screen.queryByText('Loading renewal history…')).not.toBeInTheDocument();
  });

  test('shows an error and no stale rows when loading history fails', async () => {
    api.fetchRenewalHistory.mockImplementation(async (month) => {
      if (month === '2026-11') throw new Error('History service unavailable');
      return historyFor(month, ['Netflix']);
    });
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText('Netflix');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    expect(
      await screen.findByText('Could not load renewal history: History service unavailable'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading renewal history…')).not.toBeInTheDocument();
  });

  test('filtering by status requests failed events from page 1', async () => {
    api.fetchRenewalHistory.mockImplementation(async (month, { page = 1, status } = {}) =>
      historyFor(month, [status === 'failed' ? `Failed ${page}` : `Customer ${page}`], {
        page,
        totalPages: status === 'failed' ? 1 : 3,
      }),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-09" />);
    await screen.findByText('Customer 1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Customer 2');

    await user.selectOptions(screen.getByLabelText('Status'), 'failed');

    expect(await screen.findByText('Failed 1')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    const [month, options] = api.fetchRenewalHistory.mock.calls.at(-1);
    expect(month).toBe('2026-09');
    expect(options).toMatchObject({ status: 'failed', page: 1 });
    expect(api.fetchRenewalHistory.mock.calls.some(([, opts]) => opts.status === 'failed' && opts.page !== 1)).toBe(
      false,
    );
  });

  test('switching month from page 3 shows page 1 of the new month', async () => {
    api.fetchRenewalHistory.mockImplementation(async (month, { page = 1 } = {}) =>
      historyFor(month, [`${month} customer ${page}`], { page, totalPages: month === '2026-09' ? 6 : 2 }),
    );
    const user = userEvent.setup();

    render(<App initialMonth="2026-09" />);
    await screen.findByText('2026-09 customer 1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('2026-09 customer 2');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 3 of 6');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-10');

    expect(await screen.findByText('2026-10 customer 1')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    const octoberCalls = api.fetchRenewalHistory.mock.calls.filter(([month]) => month === '2026-10');
    expect(octoberCalls.map(([, opts]) => opts.page)).toEqual([1]);
  });

  test('clamps the page when the response has fewer pages than requested', async () => {
    api.fetchRenewalHistory
      .mockResolvedValueOnce(historyFor('2026-09', ['Customer 1'], { page: 1, totalPages: 3 }))
      .mockResolvedValueOnce(historyFor('2026-09', ['Customer 2'], { page: 2, totalPages: 3 }))
      .mockImplementation(async (month, { page = 1 } = {}) =>
        historyFor(month, [`Customer ${page}`], { page, totalPages: 1 }),
      );
    api.runRenewals.mockResolvedValue({ month: '2026-09', dueCount: 0, createdCount: 0 });
    const user = userEvent.setup();

    render(<App initialMonth="2026-09" />);
    await screen.findByText('Customer 1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');

    await user.click(screen.getByRole('button', { name: 'Run renewals' }));

    expect(await screen.findByText('Page 1 of 1')).toBeInTheDocument();
    expect(api.fetchRenewalHistory.mock.calls.at(-1)[1]).toMatchObject({ page: 1 });
  });

  describe('revenue summary polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      api.fetchRenewalHistory.mockImplementation(async (month) => historyFor(month, ['Netflix']));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function flush() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    test('polls only the selected month and stops on unmount', async () => {
      const { unmount } = render(<App initialMonth="2026-10" />);
      await flush();
      expect(api.fetchSummary.mock.calls.map(([month]) => month)).toEqual(['2026-10']);

      fireEvent.change(screen.getByLabelText('Billing month'), { target: { value: '2026-11' } });
      await flush();

      api.fetchSummary.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS * 2 + 100);
      });
      const polled = api.fetchSummary.mock.calls.map(([month]) => month);
      expect(polled.length).toBe(2);
      expect(polled.every((month) => month === '2026-11')).toBe(true);

      unmount();
      api.fetchSummary.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS * 3);
      });
      expect(api.fetchSummary).not.toHaveBeenCalled();
    });

    test('a late summary for the previous month does not overwrite the new month', async () => {
      const october = deferred();
      api.fetchSummary.mockImplementation((month) =>
        month === '2026-10' ? october.promise : Promise.resolve(summaryFor(month, 50000)),
      );

      render(<App initialMonth="2026-10" />);
      await flush();

      fireEvent.change(screen.getByLabelText('Billing month'), { target: { value: '2026-11' } });
      await flush();
      expect(screen.getByTestId('summary-total')).toHaveTextContent('$500.00');

      await act(async () => {
        october.resolve(summaryFor('2026-10', 12345));
        await october.promise;
      });
      expect(screen.getByTestId('summary-total')).toHaveTextContent('$500.00');
    });

    test('clears the previous month summary while the new month loads', async () => {
      const november = deferred();
      api.fetchSummary.mockImplementation((month) =>
        month === '2026-11' ? november.promise : Promise.resolve(summaryFor(month, 12345)),
      );

      render(<App initialMonth="2026-10" />);
      await flush();
      expect(screen.getByTestId('summary-total')).toHaveTextContent('$123.45');

      fireEvent.change(screen.getByLabelText('Billing month'), { target: { value: '2026-11' } });
      await flush();
      expect(screen.queryByTestId('summary-total')).not.toBeInTheDocument();

      await act(async () => {
        november.resolve(summaryFor('2026-11', 50000));
        await november.promise;
      });
      expect(screen.getByTestId('summary-total')).toHaveTextContent('$500.00');
    });
  });
});

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetchRenewalHistory sends status only when set and forwards the abort signal', async () => {
    const realApi = await vi.importActual('../src/api.js');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await realApi.fetchRenewalHistory('2026-10', { page: 2, pageSize: 25, status: '' });
    await realApi.fetchRenewalHistory('2026-10', { status: 'failed', signal: controller.signal });

    const [firstUrl] = fetchMock.mock.calls[0];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1];
    expect(firstUrl).toBe('/api/renewals?month=2026-10&page=2&pageSize=25');
    expect(secondUrl).toBe('/api/renewals?month=2026-10&page=1&pageSize=25&status=failed');
    expect(secondOptions.signal).toBe(controller.signal);
  });
});
