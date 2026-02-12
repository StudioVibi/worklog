# Worklog Backend

Single-process backend for Worklog:

- REST API (`/v1/logs`, `/v1/sync/status`, `/health`)
- batched outbound GitHub sync job
- inbound GitHub poller job

## Run

1. Copy `.env.example` to `.env` and fill values.
2. Install dependencies: `npm install`
3. Run migrations: `npm run migrate`
4. Start server: `npm run dev` or `npm start`

By default, the backend runs on `http://localhost:8787`.

## Local PostgreSQL quick setup (Homebrew)

If `npm run migrate` fails with `database "<your-user>" does not exist`, create the project DB first:

```bash
createdb worklog
```

This project default uses a local Unix socket connection:

```env
DATABASE_URL=postgresql:///worklog?host=/tmp
```

Then run:

```bash
npm run migrate
npm run dev
```

Quick smoke test:

```bash
curl http://localhost:8787/health
curl 'http://localhost:8787/v1/logs?limit=5'
```

## Authentication (GitHub OAuth + org restriction)

The backend requires GitHub OAuth login and only allows users that are active members of `GITHUB_ALLOWED_ORG`.

Required env vars:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_ALLOWED_ORG=StudioVibi`
- `SESSION_SECRET` (strong random string)

Optional:

- `GITHUB_OAUTH_REDIRECT_URI` (if not set, backend uses request host + `/v1/auth/callback`)
- `AUTH_SUCCESS_REDIRECT` (default `/`)
- `AUTH_ERROR_REDIRECT` (default `/?auth=denied`)

GitHub sync still uses server-side `GITHUB_PAT`.

### GitHub OAuth app settings

Create a GitHub OAuth App and set:

- Homepage URL: your frontend URL (example: `http://localhost:8080`)
- Authorization callback URL: backend callback URL (example: `http://localhost:8787/v1/auth/callback`)

If frontend and backend are on different origins in local/dev, set:

- `AUTH_SUCCESS_REDIRECT=http://localhost:8080`
- `CORS_ORIGIN=http://localhost:8080`
