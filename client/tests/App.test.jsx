import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import * as api from '../src/api.js';

vi.mock('../src/api.js', () => ({
  fetchRenewalHistory: vi.fn(),
  runRenewals: vi.fn(),
}));

function historyFor(month, names) {
  return {
    month,
    count: names.length,
    events: names.map((name, i) => ({
      id: `${month}-${i}`,
      billingMonth: month,
      amount: 1000,
      currency: 'USD',
      status: 'scheduled',
      createdAt: '2026-10-01T10:00:00.000Z',
      subscription: { id: `sub-${name}`, name, plan: 'Standard', billingCycle: 'monthly' },
    })),
  };
}

describe('App', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('shows renewal history for the initial month', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', ['Netflix', 'Figma']));

    render(<App initialMonth="2026-10" />);

    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Figma')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeInTheDocument();
    expect(api.fetchRenewalHistory.mock.calls[0][0]).toBe('2026-10');
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

  test('shows an error when running renewals fails', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', []));
    api.runRenewals.mockRejectedValue(new Error('Renewal service unavailable'));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText(/No renewal events/);

    await user.click(screen.getByRole('button', { name: 'Run renewals' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Renewal service unavailable');
  });

  test('a slow response for a previous month never replaces the selected month', async () => {
    const pending = {};
    api.fetchRenewalHistory.mockImplementation((month) => new Promise((resolve) => (pending[month] = resolve)));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    // November answers first, then the stale October request finishes late.
    await act(async () => pending['2026-11'](historyFor('2026-11', ['Spotify'])));
    await act(async () => pending['2026-10'](historyFor('2026-10', ['Netflix'])));

    expect(screen.getByText('Spotify')).toBeInTheDocument();
    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /November 2026/ })).toBeInTheDocument();
  });

  test('aborts the previous request when the month changes', async () => {
    api.fetchRenewalHistory.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    const [octoberCall, novemberCall] = api.fetchRenewalHistory.mock.calls;
    expect(octoberCall[1].signal.aborted).toBe(true);
    expect(novemberCall[1].signal.aborted).toBe(false);
  });

  test('does not show the previous month while the new month is loading', async () => {
    api.fetchRenewalHistory
      .mockResolvedValueOnce(historyFor('2026-10', ['Netflix']))
      .mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await screen.findByText('Netflix');

    await user.selectOptions(screen.getByLabelText('Billing month'), '2026-11');

    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
    expect(screen.queryByText(/No renewal events/)).not.toBeInTheDocument();
    expect(screen.getByText(/Loading renewal history/)).toBeInTheDocument();
  });

  test('shows an error with a retry when loading history fails', async () => {
    api.fetchRenewalHistory
      .mockRejectedValueOnce(new Error('Internal Server Error'))
      .mockResolvedValue(historyFor('2026-10', ['Netflix']));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load renewal history: Internal Server Error');
    expect(screen.queryByText(/No renewal events/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('disables the run button while a run is in progress', async () => {
    api.fetchRenewalHistory.mockResolvedValue(historyFor('2026-10', []));
    api.runRenewals.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    render(<App initialMonth="2026-10" />);
    await user.click(screen.getByRole('button', { name: 'Run renewals' }));

    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
    expect(api.runRenewals).toHaveBeenCalledTimes(1);
  });
});
