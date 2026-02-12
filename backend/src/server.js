const express = require('express');
const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require('crypto');

const config = require('./config');
const HttpError = require('./http-error');
const { pool, query, withTransaction } = require('./db/pool');
const { createContentHash } = require('./services/hash');
const { buildGitHubPath, parseLogPath, sanitizeUsername } = require('./services/log-path');
const { toApiLog } = require('./services/log-record');
const { GitHubClient } = require('./services/github-client');
const { runOutboundSync } = require('./services/outbound-sync');
const { runInboundPoll } = require('./services/inbound-poller');
const { startScheduler } = require('./services/scheduler');

const SESSION_COOKIE = 'worklog_session';
const OAUTH_STATE_COOKIE = 'worklog_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_SCOPE = 'read:org';

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parseIsoDate(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${fieldName} must be a valid ISO datetime`);
  }
  return date;
}

function parseLimit(value, fallback = 2000) {
  if (value == null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new HttpError(400, 'limit must be a positive number');
  }
  return Math.min(10000, Math.floor(num));
}

function normalizeUserLogin(raw) {
  const cleaned = sanitizeUsername(String(raw || '').trim());
  return cleaned === 'unknown' ? '' : cleaned;
}

function buildOverlapError(overlapRow) {
  return new HttpError(409, 'This timespan overlaps an existing worklog from the same user.', {
    overlapLogId: overlapRow.id,
    overlapPath: overlapRow.github_path
  });
}

function toBase64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  if (!raw) return {};

  const out = {};
  const pairs = raw.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }

  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  if (Number.isFinite(options.maxAge)) {
    const maxAge = Math.max(0, Math.floor(options.maxAge));
    parts.push(`Max-Age=${maxAge}`);
  }

  return parts.join('; ');
}

function setCookie(res, name, value, options) {
  res.append('Set-Cookie', serializeCookie(name, value, options));
}

function signString(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function signPayload(payload, secret) {
  const payloadText = JSON.stringify(payload);
  const payloadEncoded = toBase64Url(Buffer.from(payloadText, 'utf8'));
  const signature = signString(payloadEncoded, secret);
  return `${payloadEncoded}.${signature}`;
}

function readSignedPayload(token, secret) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;

  const payloadEncoded = parts[0];
  const signature = parts[1];
  const expected = signString(payloadEncoded, secret);
  if (!safeEqual(signature, expected)) return null;

  let payload = null;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded).toString('utf8'));
  } catch (err) {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
  return payload;
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

function getOAuthRedirectUri(req) {
  if (config.auth.oauthRedirectUri) return config.auth.oauthRedirectUri;
  return `${getRequestOrigin(req)}/v1/auth/callback`;
}

function isOAuthConfigured() {
  return !!(config.auth.oauthClientId && config.auth.oauthClientSecret && config.auth.allowedOrg);
}

async function exchangeOAuthCode(code, redirectUri) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'worklog-backend'
    },
    body: JSON.stringify({
      client_id: config.auth.oauthClientId,
      client_secret: config.auth.oauthClientSecret,
      code,
      redirect_uri: redirectUri
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const errMessage = payload.error_description || payload.error || 'Failed to exchange OAuth code';
    throw new Error(errMessage);
  }

  return payload.access_token;
}

async function fetchGitHubUser(accessToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'worklog-backend'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub user (${response.status})`);
  }

  return await response.json();
}

function parseOAuthScopes(headerValue) {
  return String(headerValue || '')
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean);
}

async function readGithubErrorMessage(response) {
  const payload = await response.json().catch(() => null);
  const message = payload && payload.message ? String(payload.message) : '';
  return message || `HTTP ${response.status}`;
}

async function isUserInAllowedOrg(accessToken) {
  const allowedOrg = String(config.auth.allowedOrg || '').trim().toLowerCase();
  if (!allowedOrg) {
    throw new Error('GITHUB_ALLOWED_ORG is not configured');
  }

  const endpoint = `https://api.github.com/user/memberships/orgs/${encodeURIComponent(config.auth.allowedOrg)}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'worklog-backend'
    }
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const message = await readGithubErrorMessage(response);
    const scopes = parseOAuthScopes(response.headers.get('x-oauth-scopes'));

    // Fallback for some org configurations where membership endpoint is restricted.
    const orgsResponse = await fetch('https://api.github.com/user/orgs?per_page=200', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'worklog-backend'
      }
    });

    if (orgsResponse.ok) {
      const orgs = await orgsResponse.json().catch(() => []);
      const found = Array.isArray(orgs)
        && orgs.some(org => String(org && org.login ? org.login : '').toLowerCase() === allowedOrg);
      if (found) return true;
      return false;
    }

    const orgsMessage = await readGithubErrorMessage(orgsResponse);
    const hints = [];
    if (!scopes.includes('read:org')) {
      hints.push('missing read:org OAuth scope');
    }
    if (response.status === 403 || orgsResponse.status === 403) {
      hints.push('OAuth app may need StudioVibi org approval');
    }

    const hintText = hints.length > 0 ? ` (${hints.join('; ')})` : '';
    throw new Error(
      `Failed org membership check (${response.status}: ${message}; fallback ${orgsResponse.status}: ${orgsMessage})${hintText}`
    );
  }

  const payload = await response.json().catch(() => null);
  const state = payload && payload.state ? String(payload.state) : '';
  return state.toLowerCase() === 'active';
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  return readSignedPayload(token, config.auth.sessionSecret);
}

function requireAuth(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session || !session.login) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  req.auth = {
    login: normalizeUserLogin(session.login),
    avatarUrl: session.avatarUrl || '',
    name: session.name || ''
  };

  next();
}

function clearAuthCookies(res) {
  setCookie(res, SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.auth.cookieSecure,
    path: '/'
  });

  setCookie(res, OAUTH_STATE_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.auth.cookieSecure,
    path: '/'
  });
}

async function findIdempotentLog(client, userLogin, idempotencyKey) {
  const result = await client.query(
    `
      SELECT l.*
      FROM idempotency_keys ik
      JOIN logs l ON l.id = ik.log_id
      WHERE ik.user_login = $1
        AND ik.idempotency_key = $2
      LIMIT 1
    `,
    [userLogin, idempotencyKey]
  );

  return result.rows[0] || null;
}

const app = express();
const github = new GitHubClient(config.github);

app.use((req, res, next) => {
  const requestedOrigin = req.headers.origin;
  let origin = config.corsOrigin || '*';

  if (origin === '*' && requestedOrigin) {
    origin = requestedOrigin;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  if (origin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Idempotency-Key');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  next();
});

app.use(express.json({ limit: '256kb' }));

app.get('/health', asyncHandler(async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, time: new Date().toISOString() });
}));

app.get('/v1/auth/login', asyncHandler(async (req, res) => {
  if (!isOAuthConfigured()) {
    throw new HttpError(500, 'GitHub OAuth is not configured');
  }

  const state = randomBytes(24).toString('hex');
  const stateToken = signPayload({ state, exp: Date.now() + OAUTH_STATE_TTL_MS }, config.auth.sessionSecret);
  setCookie(res, OAUTH_STATE_COOKIE, stateToken, {
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.auth.cookieSecure,
    path: '/'
  });

  const redirectUri = getOAuthRedirectUri(req);
  const params = new URLSearchParams({
    client_id: config.auth.oauthClientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    state,
    allow_signup: 'false'
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}));

app.get('/v1/auth/callback', asyncHandler(async (req, res) => {
  if (!isOAuthConfigured()) {
    throw new HttpError(500, 'GitHub OAuth is not configured');
  }

  const fail = () => {
    clearAuthCookies(res);
    res.redirect(config.auth.errorRedirect);
  };

  const code = String(req.query.code || '').trim();
  const state = String(req.query.state || '').trim();
  if (!code || !state) {
    fail();
    return;
  }

  const cookies = parseCookies(req);
  const statePayload = readSignedPayload(cookies[OAUTH_STATE_COOKIE], config.auth.sessionSecret);
  if (!statePayload || !safeEqual(state, statePayload.state)) {
    fail();
    return;
  }

  try {
    const redirectUri = getOAuthRedirectUri(req);
    const accessToken = await exchangeOAuthCode(code, redirectUri);
    const user = await fetchGitHubUser(accessToken);
    const allowed = await isUserInAllowedOrg(accessToken);

    if (!allowed) {
      fail();
      return;
    }

    const login = normalizeUserLogin(user.login);
    if (!login) {
      fail();
      return;
    }

    const sessionToken = signPayload(
      {
        login,
        avatarUrl: user.avatar_url || '',
        name: user.name || '',
        exp: Date.now() + config.auth.sessionTtlMs
      },
      config.auth.sessionSecret
    );

    setCookie(res, SESSION_COOKIE, sessionToken, {
      maxAge: Math.floor(config.auth.sessionTtlMs / 1000),
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.auth.cookieSecure,
      path: '/'
    });

    setCookie(res, OAUTH_STATE_COOKIE, '', {
      maxAge: 0,
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.auth.cookieSecure,
      path: '/'
    });

    res.redirect(config.auth.successRedirect);
  } catch (err) {
    console.error('[auth] callback failed', err);
    fail();
  }
}));

app.get('/v1/auth/me', asyncHandler(async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session || !session.login) {
    throw new HttpError(401, 'Not authenticated');
  }

  res.json({
    login: normalizeUserLogin(session.login),
    avatar_url: session.avatarUrl || '',
    name: session.name || ''
  });
}));

app.post('/v1/auth/logout', asyncHandler(async (req, res) => {
  clearAuthCookies(res);
  res.status(204).send('');
}));

app.get('/v1/logs', requireAuth, asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];

  if (req.query.from) {
    params.push(parseIsoDate(req.query.from, 'from'));
    clauses.push(`end_at >= $${params.length}`);
  }

  if (req.query.to) {
    params.push(parseIsoDate(req.query.to, 'to'));
    clauses.push(`start_at <= $${params.length}`);
  }

  if (req.query.user) {
    params.push(normalizeUserLogin(req.query.user));
    clauses.push(`user_login = $${params.length}`);
  }

  const limit = parseLimit(req.query.limit, 2000);
  params.push(limit);

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT *
    FROM logs
    ${whereSql}
    ORDER BY end_at ASC
    LIMIT $${params.length}
  `;

  const result = await query(sql, params);
  res.json({
    logs: result.rows.map(row => toApiLog(row, config))
  });
}));

app.post('/v1/logs', requireAuth, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const parsedPath = body.path ? parseLogPath(body.path, {
    defaultDurationMs: config.defaultIntervalMs,
    timeZone: body.timezone || config.defaultTimeZone
  }) : null;

  const userLogin = normalizeUserLogin(req.auth && req.auth.login);
  if (!userLogin) {
    throw new HttpError(401, 'Not authenticated');
  }

  const text = String(body.text || '').trim();
  if (!text) {
    throw new HttpError(400, 'text is required');
  }

  if (text.length > 5000) {
    throw new HttpError(400, 'text is too long (max 5000 chars)');
  }

  const timezone = String(body.timezone || config.defaultTimeZone);

  let durationMs = Number(body.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    durationMs = parsedPath ? parsedPath.durationMs : config.defaultIntervalMs;
  }
  durationMs = Math.max(60 * 1000, Math.floor(durationMs));

  let startAt = body.startAt ? parseIsoDate(body.startAt, 'startAt') : (parsedPath ? parsedPath.startAt : null);
  let endAt = body.endAt ? parseIsoDate(body.endAt, 'endAt') : (parsedPath ? parsedPath.endAt : null);

  if (!startAt && endAt) {
    startAt = new Date(endAt.getTime() - durationMs);
  }
  if (!endAt && startAt) {
    endAt = new Date(startAt.getTime() + durationMs);
  }
  if (!startAt || !endAt) {
    throw new HttpError(400, 'startAt and endAt are required');
  }

  const actualDurationMs = endAt.getTime() - startAt.getTime();
  if (actualDurationMs <= 0) {
    throw new HttpError(400, 'endAt must be greater than startAt');
  }
  durationMs = actualDurationMs;

  const stored = await withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await findIdempotentLog(client, userLogin, idempotencyKey);
      if (existing) {
        return {
          reused: true,
          row: existing
        };
      }
    }

    const overlap = await client.query(
      `
        SELECT id, github_path
        FROM logs
        WHERE user_login = $1
          AND start_at < $2
          AND end_at > $3
        LIMIT 1
      `,
      [userLogin, endAt, startAt]
    );

    if (overlap.rowCount > 0) {
      throw buildOverlapError(overlap.rows[0]);
    }

    const id = randomUUID();
    const githubPath = buildGitHubPath({
      id,
      endAt,
      durationMs,
      userLogin,
      timeZone: timezone
    });

    const insertLog = await client.query(
      `
        INSERT INTO logs (
          id,
          user_login,
          start_at,
          end_at,
          duration_ms,
          text,
          timezone,
          source,
          github_path,
          content_sha256
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'api', $8, $9)
        RETURNING *
      `,
      [
        id,
        userLogin,
        startAt,
        endAt,
        durationMs,
        text,
        timezone,
        githubPath,
        createContentHash(text)
      ]
    );

    await client.query(
      `
        INSERT INTO sync_outbox (log_id, status, next_retry_at)
        VALUES ($1, 'pending', now())
      `,
      [id]
    );

    if (idempotencyKey) {
      try {
        await client.query(
          `
            INSERT INTO idempotency_keys (user_login, idempotency_key, log_id)
            VALUES ($1, $2, $3)
          `,
          [userLogin, idempotencyKey, id]
        );
      } catch (err) {
        if (err && err.code === '23505') {
          const existing = await findIdempotentLog(client, userLogin, idempotencyKey);
          if (existing) {
            return {
              reused: true,
              row: existing
            };
          }
        }
        throw err;
      }
    }

    return {
      reused: false,
      row: insertLog.rows[0]
    };
  });

  res.status(stored.reused ? 200 : 201).json(toApiLog(stored.row, config));
}));

app.get('/v1/sync/status', requireAuth, asyncHandler(async (req, res) => {
  const counts = await query(
    `
      SELECT status, COUNT(*)::bigint AS count
      FROM sync_outbox
      GROUP BY status
    `
  );

  const outbox = {
    pending: 0,
    inflight: 0,
    done: 0,
    failed: 0,
    dead: 0
  };

  for (const row of counts.rows) {
    outbox[row.status] = Number(row.count);
  }

  const lag = await query(
    `
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::bigint AS oldest_age_seconds
      FROM sync_outbox
      WHERE status IN ('pending', 'failed', 'inflight')
    `
  );

  const syncRows = await query('SELECT name, last_seen_commit_sha, updated_at FROM sync_state ORDER BY name');
  const syncState = {};
  for (const row of syncRows.rows) {
    syncState[row.name] = {
      lastSeenCommitSha: row.last_seen_commit_sha,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  res.json({
    githubEnabled: github.isEnabled(),
    outbox,
    oldestPendingAgeSeconds: Number(lag.rows[0] && lag.rows[0].oldest_age_seconds ? lag.rows[0].oldest_age_seconds : 0),
    syncState,
    serverTime: new Date().toISOString()
  });
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      details: err.details || null
    });
    return;
  }

  console.error('[server] unhandled error', err);
  res.status(500).json({
    error: 'Internal server error'
  });
});

let stopScheduler = () => {};

async function bootstrap() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  await query('SELECT 1');

  if (config.syncEnabled) {
    stopScheduler = startScheduler({
      config,
      runOutbound: () => runOutboundSync({ pool, github, config, logger: console }),
      runInbound: () => runInboundPoll({ pool, github, config, logger: console }),
      logger: console
    });
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log('[server] shutting down');
    stopScheduler();

    await new Promise((resolve) => {
      server.close(() => resolve());
    });

    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
