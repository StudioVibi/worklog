# Worklog

Worklog is a lightweight hourly logging tool.

## Architecture

- Frontend: static app (`index.html`, `css/`, `js/`)
- Backend: single Node.js service (`backend/`)
  - REST API for logs
  - batched outbound sync to `StudioVibi/worklogs`
  - inbound GitHub poller (`head > last_seen`) to import external changes
  - GitHub OAuth authentication restricted to StudioVibi org members
- Database: PostgreSQL (source of truth)

GitHub is an asynchronous mirror; writes go to DB first.

## Frontend

The frontend is static and can be served from any static host.

Optional API base override in browser:

```js
localStorage.setItem('worklog_api_base', 'https://your-backend-url')
```

If unset, the app uses same-origin API paths.

## Backend setup

From `/Users/lorenzobattistela/work/worklog/backend`:

1. Copy `.env.example` to `.env` and fill values (`DATABASE_URL`, `GITHUB_PAT`, etc).
  - Also set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_ALLOWED_ORG`, `SESSION_SECRET`.
2. Install dependencies:

```bash
npm install
```

3. Run DB migrations:

```bash
npm run migrate
```

4. Start server:

```bash
npm run dev
```

Default backend address is `http://localhost:8787`.

## Sync cadence

- Outbound batch sync: every 15 minutes (`SYNC_OUTBOUND_CRON`)
- Inbound poller: every 10 minutes (`SYNC_INBOUND_CRON`)

Both jobs run in the same backend process with Postgres advisory locks.
