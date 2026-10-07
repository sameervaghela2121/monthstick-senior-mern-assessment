import { useCallback, useEffect, useState } from 'react';
import { fetchRenewalHistory } from '../api.js';

const LOADING = { status: 'loading', events: [], error: null };

// Loads the renewal history for `month` and guarantees the result belongs to that month:
// - every request is aborted when the month changes (or the component unmounts), and a response that still
//   arrives afterwards is ignored, so a slow October response can never overwrite November;
// - state is tagged with the month it was loaded for, so on the render right after a month switch (before the
//   effect has run) the previous month's rows are not shown under the new month's heading.
export function useRenewalHistory(month) {
  const [state, setState] = useState({ month: null, ...LOADING });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const isStale = () => controller.signal.aborted;

    // A reload of the same month keeps the current rows visible while refreshing; a new month starts empty.
    setState((prev) => (prev.month === month ? { ...prev, status: 'loading', error: null } : { month, ...LOADING }));

    fetchRenewalHistory(month, { signal: controller.signal })
      .then((data) => {
        if (!isStale()) setState({ month, status: 'success', events: data.events, error: null });
      })
      .catch((err) => {
        if (!isStale()) setState({ month, status: 'error', events: [], error: err.message });
      });

    return () => controller.abort();
  }, [month, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const { status, events, error } = state.month === month ? state : LOADING;
  return { status, events, error, reload };
}
