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

export function fetchRenewalHistory(month, { page = 1, pageSize = 25, status = '' } = {}) {
  const params = new URLSearchParams({ month, page: String(page), pageSize: String(pageSize) });
  if (status) {
    params.append('status', status);
  }
  return request(`/renewals?${params}`);
}

export function fetchSummary(month) {
  return request(`/renewals/summary?month=${encodeURIComponent(month)}`);
}

export function runRenewals(month) {
  return request('/renewals/run', {
    method: 'POST',
    body: JSON.stringify({ month }),
  });
}

export function retryFailedCharges(month) {
  return request('/renewals/retry-failed', {
    method: 'POST',
    body: JSON.stringify({ month }),
  });
}
