# Senior MERN Developer Technical Assessment: MonthStick Renewal Console

This exercise reflects the kind of maintenance and production-reliability work you may encounter in the role. You will work in an existing MERN application, investigate reported issues, implement focused fixes, and submit the work as a pull request.

## Assessment details

| Item | Details |
|---|---|
| Role | Senior MERN Stack Developer |
| Expected time | 45–60 minutes |
| Base branch | `main` |
| Submission | Pull request to this repository's `main` branch |

AI-assisted development tools are allowed and encouraged. You may use Codex, Claude, GitHub Copilot, Cursor, or similar tools, but you must understand and be able to explain the code you submit.

## Product context

MonthStick is a dashboard for managing recurring subscriptions such as Netflix, Figma, and gym memberships.

Administrators run a monthly renewal process that creates a renewal event for each active subscription due in the selected month. The dashboard then displays the renewal history.

The repository contains a working application with a number of known production issues. Your task is to identify the relevant implementation areas and resolve the issues below.

## Your task

### 1. Prevent duplicate renewal events

Users have reported that renewal events can be duplicated when the renewal process is run more than once for the same month. This can happen after a double-click, a network retry, or two administrators running the process at nearly the same time.

For any given subscription and billing month, the system must create **at most one** renewal event.

Requirements:

- Make the solution safe at the database level, not only in the browser or with an in-memory lock.
- Ensure repeated and concurrent requests cannot create duplicates.
- Return a useful response showing what was newly created and what already existed.
- Do not silently swallow unexpected database errors.

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

### 4. Validate month input

Invalid month values currently may cause an internal server error.

A valid billing month is formatted as `YYYY-MM`, for example `2026-10`.

Requirements:

- Return a clear `400 Bad Request` response for invalid input.
- Return useful JSON error information.
- Do not expose stack traces or internal database details to the client.

## Expected application behaviour

After your changes:

- Running renewals for a month creates events only for active subscriptions due in that month.
- Re-running the same month does not create duplicate events.
- Concurrent requests cannot create duplicate events.
- Paused subscriptions do not generate renewal events.
- Invalid month values are rejected cleanly.
- Renewal history matches the month selected in the UI.
- Renewal history is retrieved efficiently as data grows.

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

**Requirements:** Node.js 20 or newer. **You do not need to install MongoDB.** If `MONGODB_URI` is not set, the API starts an in-memory MongoDB and seeds it automatically. Its data resets on every restart.

```bash
npm install          # installs root, server and client workspaces
npm run dev          # API on http://localhost:4000, dashboard on http://localhost:5173
npm test             # runs the server and client test suites
```

The first `npm run dev` or `npm test` downloads a MongoDB binary (~100 MB, one time only).

Other useful commands:

| Command | What it does |
|---|---|
| `npm run dev:large` | Same as `dev`, but seeds ~2,000 extra subscriptions with September 2026 history |
| `npm run test:server` / `npm run test:client` | Run one suite |
| `MONGODB_URI=mongodb://127.0.0.1:27017/monthstick npm run dev` | Use your own MongoDB instead of the in-memory one |
| `MONGODB_URI=... npm run seed -w server [-- --large]` | Reset and seed your own MongoDB |

### Project layout

```text
server/                 Express + Mongoose API (CommonJS, node:test + supertest)
  src/app.js            Express app
  src/models/           Subscription, RenewalEvent
  src/routes/           /api/renewals, /api/subscriptions
  src/utils/billing.js  Month and billing-cycle helpers
  scripts/seedData.js   Sample data (also used by tests)
  tests/                API tests (in-memory MongoDB)
client/                 React dashboard (Vite, Vitest + Testing Library)
  src/App.jsx           Dashboard page
  src/api.js            API client
  tests/                Component tests
```

### API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/renewals/run` | Body `{ "month": "YYYY-MM" }`. Creates renewal events for active subscriptions due that month and returns a run summary. |
| `GET` | `/api/renewals?month=YYYY-MM` | Renewal history for the month: `{ month, count, events: [{ id, billingMonth, amount, currency, status, createdAt, subscription: { id, name, plan, billingCycle } }] }` |
| `GET` | `/api/subscriptions` | All subscriptions |
| `GET` | `/api/health` | Health check |

Amounts are in minor units (cents).

### Seed data

| Subscription | Cycle | Status | Starts | Due in Oct 2026 | Due in Nov 2026 |
|---|---|---|---|---|---|
| Netflix | monthly | active | 2025-01 | ✅ | ✅ |
| Figma | yearly | active | 2024-10 | ✅ | |
| Notion | yearly | active | 2025-11 | | ✅ |
| Spotify | monthly | active | 2026-11 | | ✅ |
| GitHub Copilot | monthly | active | 2026-02 | ✅ | ✅ |
| Gold's Gym | monthly | **paused** | 2025-06 | | |
| Adobe Creative Cloud | monthly | **cancelled** | 2024-03 | | |

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
- Payment-provider integration
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

## Final checklist

Before submitting your pull request, please confirm that:

- [ ] The application runs locally.
- [ ] Relevant automated tests pass.
- [ ] You have manually verified the renewal flow.
- [ ] Your PR branch follows the required naming format.
- [ ] Your PR title follows the required naming format.
- [ ] Your PR description contains the requested summary, testing, trade-offs, and AI-usage notes.
- [ ] Your PR targets the original repository's `main` branch.

Thank you, and good luck....
