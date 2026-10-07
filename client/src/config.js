export const PAGE_SIZE = 25;

// The revenue card refreshes itself while the dashboard is open, so charges recorded by
// payment webhooks show up without a reload.
export const SUMMARY_POLL_MS = 10_000;
