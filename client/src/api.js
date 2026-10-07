async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `Request failed with status ${response.status}`);
  }
  return body;
}

export function fetchRenewalHistory(month, signal) {
  return request(`/renewals?month=${encodeURIComponent(month)}`, { signal });
}

export function runRenewals(month) {
  return request('/renewals/run', {
    method: 'POST',
    body: JSON.stringify({ month }),
  });
}
