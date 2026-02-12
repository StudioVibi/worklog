const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const DEFAULT_OUTBOUND_CRON = '*/15 * * * *';
const DEFAULT_INBOUND_CRON = '*/10 * * * *';

function loadDotEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!key) continue;

    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile();

function parseInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEveryMinutesCron(raw, fallbackMinutes) {
  const value = String(raw || '').trim();
  const cronMatch = value.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (cronMatch) {
    const minutes = parseInteger(cronMatch[1], fallbackMinutes);
    if (minutes > 0) return minutes;
  }

  const numericMinutes = parseInteger(value, fallbackMinutes);
  if (numericMinutes > 0) return numericMinutes;
  return fallbackMinutes;
}

const outboundMinutes = parseEveryMinutesCron(
  process.env.SYNC_OUTBOUND_CRON || DEFAULT_OUTBOUND_CRON,
  15
);
const inboundMinutes = parseEveryMinutesCron(
  process.env.SYNC_INBOUND_CRON || DEFAULT_INBOUND_CRON,
  10
);

const defaultIntervalMinutes = Math.max(1, parseInteger(process.env.DEFAULT_INTERVAL_MINUTES, 60));
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInteger(process.env.PORT, 8787),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: parseBoolean(process.env.DATABASE_SSL, false),

  github: {
    owner: process.env.GITHUB_OWNER || 'StudioVibi',
    repo: process.env.GITHUB_REPO || 'worklogs',
    pat: process.env.GITHUB_PAT || ''
  },
  auth: {
    oauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    oauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
    allowedOrg: process.env.GITHUB_ALLOWED_ORG || 'StudioVibi',
    oauthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI || '',
    successRedirect: process.env.AUTH_SUCCESS_REDIRECT || '/',
    errorRedirect: process.env.AUTH_ERROR_REDIRECT || '/?auth=denied',
    sessionSecret,
    sessionTtlMs: Math.max(60 * 60 * 1000, parseInteger(process.env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000)),
    cookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, false)
  },

  defaultTimeZone: process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  defaultIntervalMs: defaultIntervalMinutes * 60 * 1000,

  syncEnabled: parseBoolean(process.env.SYNC_ENABLED, true),
  syncOutboundIntervalMs: outboundMinutes * 60 * 1000,
  syncInboundIntervalMs: inboundMinutes * 60 * 1000,
  syncOutboundJitterMs: Math.max(0, parseInteger(process.env.SYNC_OUTBOUND_JITTER_MS, 120000)),
  syncInboundJitterMs: Math.max(0, parseInteger(process.env.SYNC_INBOUND_JITTER_MS, 60000)),
  syncBatchMaxLogs: Math.max(1, parseInteger(process.env.SYNC_BATCH_MAX_LOGS, 200)),
  syncBatchMaxBytes: Math.max(1024, parseInteger(process.env.SYNC_BATCH_MAX_BYTES, 2_000_000)),
  syncRateLimitFloor: Math.max(0, parseInteger(process.env.SYNC_RATE_LIMIT_FLOOR, 500)),
  syncMaxRetries: Math.max(1, parseInteger(process.env.SYNC_MAX_RETRIES, 15))
};
