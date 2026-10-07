# Senior MERN Developer Technical Assessment: MonthStick Renewal Console

This exercise reflects the kind of maintenance and production-reliability work you may encounter in the role. You will work in an existing MERN application, investigate reported issues, implement focused fixes, and submit the work as a pull request.

## Assessment details

| Item | Details |
|---|---|
| Role | Senior MERN Stack Developer |
| Expected time | 45–60 minutes |
| Base branch | `main` |
| Submission | Pull request to this repository's `main` branch |
| Questions | hr@thirdrocktechkno.com |

AI-assisted development tools are allowed and encouraged. You may use Codex, Claude, GitHub Copilot, Cursor, or similar tools, but you must understand and be able to explain the code you submit.

> **There is deliberately more work here than fits in 60 minutes.** We do not expect you to finish everything. Decide what matters most, fix it properly, and use your pull request to explain what you prioritised, what you found but did not fix, and what you would do next. Prioritisation and judgement are part of the evaluation.

## Product context

MonthStick is a dashboard for managing recurring subscriptions such as Netflix, Figma, and gym memberships.

Administrators run a monthly renewal process that creates a renewal event for each active subscription due in the selected month. Each event is then charged through our payment provider, whose webhooks report the outcome (`charged` or `failed`). Administrators can retry failed charges from the dashboard, and finance uses the revenue summary to reconcile each month.

The repository contains a working application with a number of known production issues. Your task is to identify the relevant implementation areas and resolve the issues below.

## Business rules

These rules are fixed. Code that disagrees with them is a bug.

1. **Dates and months are UTC.** A subscription's billing month is derived from its `startDate` in UTC, regardless of where the server or the user is.
2. **Money is in integer cents.** GST is **18%**, calculated **per renewal event** and rounded to the nearest cent, with **ties rounded to the even cent** (banker's rounding, as required by our accounting system). Summary totals are the sum of the per-event values.
3. **Payment status transitions:** `scheduled → charged | failed`, `failed → charged | failed`. `charged` is final. Every recorded attempt increments `attempts` by exactly one.
4. **Payment gateway** (`server/src/services/paymentGateway.js`): at most **4 concurrent** charge requests; it supports **idempotency keys**. A customer must never be charged twice for the same renewal event.
5. **History pagination:** `page` is 1-based. Paging through a month must return every event exactly once.
6. `server/scripts/seedData.js` is a **snapshot of production data**. Do not edit it to make problems go away. Your changes must work against data like it.

## Your task

### 1. Prevent duplicate renewal events

Users have reported that renewal events can be duplicated when the renewal process is run more than once for the same month. This can happen after a double-click, a network retry, or two administrators running the process at nearly the same time.

For any given subscription and billing month, the system must create **at most one** renewal event.

Requirements:

- Make the solution safe at the database level, not only in the browser or with an in-memory lock.
- Ensure repeated and concurrent requests cannot create duplicates.
- Return a useful response showing what was newly created and what already existed.
- Do not silently swallow unexpected database errors.
- Production already contains duplicates created by this bug. Explain how your change would be rolled out safely against that data.

### 2. Fix stale renewal history in the dashboard

When users switch quickly between months, the dashboard can display renewal history from a previously selected month.

For example, a request for October may finish after a request for November and incorrectly replace the November results.

Requirements:

- Ensure the displayed history always belongs to the currently selected month.
- Handle loading and API error states clearly.
- Avoid presenting stale data as current data.
- Keep the change focused and understandable.

### 3. Improve renewal-history API performance

The history endpoint slows down as renewal-event volume grows. It currently performs unnecessary repeated database work while retrieving subscription details for the history table.

Requirements:

- Remove avoidable repeated database queries.
- Use an appropriate MongoDB query strategy to return the information required by the UI.
- Add or improve database indexes when justified by the access pattern.
- Preserve the existing API contract unless a change is necessary and documented in your pull request.

### 4. Validate request input

Invalid input currently may cause an internal server error or unexpected behaviour.

Requirements:

- Validate every input the API accepts: `month` (format `YYYY-MM`, for example `2026-10`), `page`, `pageSize` (maximum 200), the status filter, event ids and status updates.
- Return a clear `400 Bad Request` response for invalid input, with useful JSON error information.
- Do not expose stack traces or internal database details to the client.

### 5. New feature: filter renewal history by status

Operations want to see only the failed charges for a month.

Requirements:

- `GET /api/renewals` accepts an optional `status` query parameter (`scheduled`, `charged` or `failed`). Without it, all events are returned.
- `count`, `totalPages` and pagination reflect the filter.
- The filtered query must stay efficient as data grows.
- In the dashboard, add a select labelled **Status** with the options **All**, **Scheduled**, **Charged** and **Failed** (option values: empty string, `scheduled`, `charged`, `failed`). Changing the filter or the month shows page 1.
- Add tests for the new behaviour.

### 6. Production reports (investigate)

These came from support and operations. They describe symptoms only. Find the root causes, fix what you can, and explain your findings in the PR.

- **6a. Finance:** "The October revenue total on the dashboard doesn't match the sum of the individual invoices. It's out by a cent or so. Also, after we run renewals or a payment comes in, the summary keeps showing the old numbers until someone restarts the server."
- **6b. Operations (Ahmedabad office):** "When we run October renewals from our office servers, Canva isn't billed. The same run on the UTC staging server includes it."
- **6c. Support:** "Paging through September history, the last few customers never appear. And after switching months on page 6, the table sometimes says 'Page 6 of 1' with no rows."
- **6d. Payments:** "Our provider sometimes delivers webhooks twice or out of order. We have customers who were charged, but MonthStick shows their renewal as failed. The attempt counts are also lower than the provider's logs."
- **6e. Operations:** "'Retry failed charges' sometimes crashes the whole API. When it doesn't, the message says everything was retried, but the charges are still failed when we refresh. The provider's dashboard shows a lot of 429 errors. Yesterday a customer complained they were charged twice for September after an admin clicked Retry twice."
- **6f. Dashboard users:** "A few seconds after switching months, the revenue card jumps back to the previous month's numbers. The Network tab shows summary requests for the old month that never stop."

## Expected application behaviour

After your changes:

- Running renewals for a month creates events only for active subscriptions due in that month.
- Re-running the same month does not create duplicate events.
- Concurrent requests cannot create duplicate events.
- Paused subscriptions do not generate renewal events.
- Invalid input is rejected cleanly.
- Renewal history matches the month and filter selected in the UI.
- Renewal history is retrieved efficiently as data grows.
- The business rules above hold under concurrent requests.

## Getting started

1. Fork the assessment repository to your GitHub account.
2. Clone your fork locally.
3. Follow the [setup instructions](#setup) below.
4. Create a branch using this exact format:

   ```text
   assessment/<your-first-name>-<your-last-name>
   ```

   Example: `assessment/jane-doe`

5. Implement the fixes.
6. Run the relevant tests and verify the application manually.
7. Push your branch to your fork.
8. Open a pull request from your branch to the original assessment repository's `main` branch.

Please do not commit directly to `main`.

## Setup

**Requirements:** Node.js 20 or newer. **You do not need to install MongoDB.** If `MONGODB_URI` is not set, the API starts an in-memory MongoDB and loads the production snapshot automatically. Its data resets on every restart.

```bash
npm install          # installs root, server and client workspaces
npm run dev          # API on http://localhost:4000, dashboard on http://localhost:5173
npm test             # runs the server and client test suites
```

The first `npm run dev` or `npm test` downloads a MongoDB binary (~100 MB, one time only). Keep an eye on the API's startup output.

Other useful commands:

| Command | What it does |
|---|---|
| `npm run dev:large` | Same as `dev`, but adds ~2,000 subscriptions with September 2026 history (about 10% failed) |
| `npm run test:server` / `npm run test:client` | Run one suite |
| `MONGODB_URI=mongodb://127.0.0.1:27017/monthstick npm run dev` | Use your own MongoDB instead of the in-memory one |
| `MONGODB_URI=... npm run seed -w server [-- --large]` | Reset your own MongoDB to the production snapshot |

### Project layout

```text
server/                          Express + Mongoose API (CommonJS, node:test + supertest)
  src/app.js                     Express app
  src/server.js                  Startup: database, snapshot data, indexes
  src/models/                    Subscription, RenewalEvent
  src/routes/                    /api/renewals, /api/subscriptions
  src/services/revenueSummary.js Revenue summary for finance
  src/services/paymentGateway.js Payment provider client (simulated)
  src/utils/billing.js           Month and billing-cycle helpers
  scripts/seedData.js            Production snapshot (also used by tests)
  tests/                         API tests (in-memory MongoDB)
client/                          React dashboard (Vite, Vitest + Testing Library)
  src/App.jsx                    Dashboard page
  src/api.js                     API client
  tests/                         Component tests
```

### API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/renewals/run` | Body `{ "month": "YYYY-MM" }`. Creates renewal events for active subscriptions due that month and returns a run summary. |
| `GET` | `/api/renewals?month=YYYY-MM&page=1&pageSize=50` | One page of history: `{ month, count, page, pageSize, totalPages, events: [{ id, billingMonth, amount, currency, status, attempts, failureReason, chargedAt, createdAt, subscription: { id, name, plan, billingCycle } }] }` |
| `GET` | `/api/renewals/summary?month=YYYY-MM` | Revenue summary in cents: `{ month, eventCount, subtotal, tax, total, byStatus: { scheduled, charged, failed } }` |
| `PATCH` | `/api/renewals/:id/status` | Payment webhook. Body `{ "status": "charged" \| "failed", "failureReason"?: string }`. Returns the updated event; `404` if unknown, `409` if the transition is not allowed. |
| `POST` | `/api/renewals/retry-failed` | Body `{ "month": "YYYY-MM" }`. Retries every failed charge in the month and responds when all retries have finished: `{ month, retried, charged, failed }`. A gateway error counts as a failed attempt. |
| `GET` | `/api/subscriptions` | All subscriptions |
| `GET` | `/api/health` | Health check |

### Seed data (production snapshot)

| Subscription | Cycle | Status | Starts (UTC) | Due in Oct 2026 | Due in Nov 2026 |
|---|---|---|---|---|---|
| Netflix | monthly | active | 2025-01-15 | ✅ | ✅ |
| Figma | yearly | active | 2024-10-03 | ✅ | |
| Notion | yearly | active | 2025-11-20 | | ✅ |
| Spotify | monthly | active | 2026-11-01 00:00 | | ✅ |
| GitHub Copilot | monthly | active | 2026-02-10 | ✅ | ✅ |
| Canva | monthly | active | 2026-10-31 21:00 | ✅ | ✅ |
| Gold's Gym | monthly | **paused** | 2025-06-01 | | |
| Adobe Creative Cloud | monthly | **cancelled** | 2024-03-12 | | |

August and September 2026 already contain renewal history, including some failed charges.

## Pull request requirements

Use this exact PR title format:

```text
[Assessment] Your First Name Your Last Name - MonthStick fixes
```

Example: `[Assessment] Jane Doe - MonthStick fixes`

In the pull-request description, include the following (this template is pre-filled when you open the PR):

```markdown
## Summary
- Briefly describe the root cause of each issue.
- Briefly describe the approach taken to resolve it.

## Testing
- Commands run:
- Manual checks completed:

## Assumptions and trade-offs
- List any assumptions, shortcuts, or deliberate decisions.

## AI usage
- Tools used:
- What AI helped with:
- How you validated AI-generated suggestions:
```

## Scope boundaries

Please keep the work focused on the reported issues. The following are out of scope:

- Authentication or authorization
- Payment-provider integration (the simulated gateway stays as is)
- Redis, queues, or external infrastructure
- Deployment or CI/CD changes
- A complete visual redesign
- Large framework migrations
- Unrelated refactoring

You may document a larger improvement you would make with more time, but do not spend the assessment time implementing it.

## How we will evaluate the submission

We will evaluate the pull request on the following areas:

| Area | What we look for |
|---|---|
| Problem solving | Identifies and addresses root causes rather than only symptoms |
| JavaScript and async reasoning | Safe handling of promises, concurrent requests, and race conditions |
| MongoDB knowledge | Appropriate indexes, efficient queries, and database-enforced integrity |
| Node and API design | Validation, errors, HTTP semantics, and maintainable backend code |
| React engineering | Reliable asynchronous state handling and clear UI states |
| Code quality | Focused, readable, maintainable changes with sensible trade-offs |
| Testing | Meaningful verification of critical changed behavior |
| AI-assisted development | Productive tool use with clear ownership and validation |
| Prioritisation | Sensible choices about what to fix first, and honest reporting of what was left |

## Final checklist

Before submitting your pull request, please confirm that:

- [ ] The application runs locally.
- [ ] Relevant automated tests pass.
- [ ] You have manually verified the renewal flow.
- [ ] Your PR branch follows the required naming format.
- [ ] Your PR title follows the required naming format.
- [ ] Your PR description contains the requested summary, testing, trade-offs, and AI-usage notes.
- [ ] Your PR targets the original repository's `main` branch.

Thank you, and good luck.
