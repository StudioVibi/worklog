const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGitHubPath,
  parseLogPath,
  formatDurationToken,
  parseDurationToken,
  sanitizeUsername
} = require('../src/services/log-path');

const SP = 'America/Sao_Paulo';

test('buildGitHubPath encodes the end time in the billing (Sao Paulo) wall-clock', () => {
  const path = buildGitHubPath({
    id: 'abc-123',
    endAt: new Date('2026-06-08T12:00:00.000Z'), // 09:00 in Sao Paulo
    durationMs: 60 * 60 * 1000,
    userLogin: 'alice',
    timeZone: SP
  });
  assert.equal(path, 'logs/2026-06-08.09h00m00s.60m00s.alice.abc-123.txt');
});

test('buildGitHubPath wall-clock follows the supplied zone, not the instant', () => {
  const instant = new Date('2026-06-08T12:00:00.000Z');
  const sp = buildGitHubPath({ id: 'x', endAt: instant, durationMs: 3600000, userLogin: 'bob', timeZone: SP });
  const ny = buildGitHubPath({ id: 'x', endAt: instant, durationMs: 3600000, userLogin: 'bob', timeZone: 'America/New_York' });
  assert.match(sp, /2026-06-08\.09h00m00s/);
  assert.match(ny, /2026-06-08\.08h00m00s/);
});

test('buildGitHubPath sanitizes usernames', () => {
  const path = buildGitHubPath({
    id: 'id1',
    endAt: new Date('2026-06-08T12:00:00.000Z'),
    durationMs: 3600000,
    userLogin: '@Foo.Bar_baz',
    timeZone: SP
  });
  // Leading @ stripped; '.' -> '-'; underscores preserved.
  assert.match(path, /\.Foo-Bar_baz\.id1\.txt$/);
});

test('parseLogPath round-trips a path built by buildGitHubPath', () => {
  const endAt = new Date('2026-06-08T12:34:00.000Z');
  const durationMs = 45 * 60 * 1000;
  const path = buildGitHubPath({ id: 'abc123', endAt, durationMs, userLogin: 'carol', timeZone: SP });

  const parsed = parseLogPath(path, { timeZone: SP });
  assert.ok(parsed, 'expected a parse result');
  assert.equal(parsed.userLogin, 'carol');
  assert.equal(parsed.durationMs, durationMs);
  assert.equal(parsed.idHint, 'abc123');
  assert.equal(parsed.endAt.getTime(), endAt.getTime());
});

test('formatDurationToken / parseDurationToken are inverse', () => {
  assert.equal(formatDurationToken(60 * 60 * 1000), '60m00s');
  assert.equal(formatDurationToken(90 * 1000), '01m30s');
  assert.equal(parseDurationToken('60m00s'), 60 * 60 * 1000);
  assert.equal(parseDurationToken('01m30s'), 90 * 1000);
  assert.equal(parseDurationToken('nonsense'), null);
});

test('parseLogPath rejects malformed paths', () => {
  assert.equal(parseLogPath(''), null);
  assert.equal(parseLogPath('logs/not-a-log.txt'), null);
  assert.equal(parseLogPath('logs/2026-06-08.99h00m00s.60m00s.alice.txt', { timeZone: SP }), null);
});

test('sanitizeUsername falls back to "unknown"', () => {
  assert.equal(sanitizeUsername(''), 'unknown');
  assert.equal(sanitizeUsername('@octocat'), 'octocat');
});
