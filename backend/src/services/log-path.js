const { getZonedParts, zonedPartsToDate, pad2, formatDateValue } = require('./timezone');

function sanitizeUsername(username) {
  const input = String(username || '').trim().replace(/^@+/, '');
  if (!input) return 'unknown';
  const safe = input.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  return safe || 'unknown';
}

function sanitizeId(id) {
  const input = String(id || '').trim();
  if (!input) return '';
  return input.replace(/[^a-zA-Z0-9-]/g, '');
}

function formatDurationToken(durationMs) {
  const totalSeconds = Math.max(1, Math.floor(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
}

function parseDurationToken(durationToken) {
  const match = String(durationToken || '').match(/^(\d{2,})m(\d{2})s$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (seconds < 0 || seconds > 59) return null;
  return (minutes * 60 + seconds) * 1000;
}

function buildGitHubPath({ id, endAt, durationMs, userLogin, timeZone }) {
  const endDate = endAt instanceof Date ? endAt : new Date(endAt);
  if (Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid endAt for log path');
  }

  const parts = getZonedParts(endDate, timeZone);
  const date = formatDateValue(parts);
  const time = `${pad2(parts.hour)}h${pad2(parts.minute)}m${pad2(parts.second)}s`;
  const durationToken = formatDurationToken(durationMs);
  const safeUser = sanitizeUsername(userLogin);
  const safeId = sanitizeId(id);
  const idSuffix = safeId ? `.${safeId}` : '';
  return `logs/${date}.${time}.${durationToken}.${safeUser}${idSuffix}.txt`;
}

function parseLogPath(path, { defaultDurationMs = 60 * 60 * 1000, timeZone = 'America/Sao_Paulo' } = {}) {
  const rawPath = String(path || '').trim();
  if (!rawPath) return null;

  const filename = rawPath.split('/').pop();
  const parts = String(filename || '').split('.');
  if (parts.length < 4) return null;
  if (parts[parts.length - 1] !== 'txt') return null;

  const dateToken = parts[0];
  const timeToken = parts[1];
  const durationToken = parts.length >= 5 ? parts[2] : null;
  const userLogin = parts.length >= 5 ? parts[3] : parts[2];
  const idHint = parts.length >= 6 ? parts[4] : null;

  const dateMatch = dateToken.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeToken.match(/^(\d{2})h(\d{2})m(\d{2})s$/);
  if (!dateMatch || !timeMatch || !userLogin) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const parsedDuration = parseDurationToken(durationToken);
  const durationMs = parsedDuration || defaultDurationMs;

  const endAt = zonedPartsToDate({ year, month, day, hour, minute, second }, timeZone);
  const startAt = new Date(endAt.getTime() - durationMs);

  return {
    path: rawPath,
    date: dateToken,
    time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    durationToken,
    durationMs,
    userLogin,
    idHint,
    startAt,
    endAt
  };
}

module.exports = {
  buildGitHubPath,
  parseLogPath,
  formatDurationToken,
  parseDurationToken,
  sanitizeUsername
};
