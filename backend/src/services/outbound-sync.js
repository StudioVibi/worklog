const { randomUUID } = require('crypto');
const { buildGitHubPath } = require('./log-path');

const OUTBOUND_LOCK_KEY = 8201001;
const STALE_INFLIGHT_MS = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;

function computeBackoffMs(nextRetries, err) {
  const exponential = Math.min(MAX_BACKOFF_MS, Math.pow(2, Math.min(nextRetries, 16)) * BASE_BACKOFF_MS);

  if (err && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
    return Math.max(exponential, err.retryAfterMs);
  }

  if (err && Number.isFinite(err.rateLimitResetMs) && err.rateLimitResetMs > 0) {
    return Math.max(exponential, err.rateLimitResetMs + 1000);
  }

  return exponential;
}

async function ensureSyncStateRow(client, name) {
  await client.query(
    `INSERT INTO sync_state (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name]
  );
}

async function reapStaleInflight(client) {
  const staleBefore = new Date(Date.now() - STALE_INFLIGHT_MS);
  const result = await client.query(
    `
      UPDATE sync_outbox
      SET
        status = 'failed',
        next_retry_at = now(),
        last_error = 'Recovered stale inflight entry',
        locked_at = NULL,
        worker_id = NULL,
        batch_id = NULL,
        updated_at = now()
      WHERE status = 'inflight' AND locked_at < $1
      RETURNING id
    `,
    [staleBefore]
  );

  return result.rowCount;
}

async function claimRows(client, limit, batchId, workerId) {
  const picked = await client.query(
    `
      WITH picked AS (
        SELECT id
        FROM sync_outbox
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= now()
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE sync_outbox so
      SET
        status = 'inflight',
        batch_id = $2,
        locked_at = now(),
        worker_id = $3,
        updated_at = now()
      FROM picked
      WHERE so.id = picked.id
      RETURNING so.id, so.log_id, so.retries
    `,
    [limit, batchId, workerId]
  );

  if (picked.rowCount === 0) return [];

  const outboxIds = picked.rows.map(row => row.id);
  const logs = await client.query(
    `
      SELECT
        so.id AS outbox_id,
        so.retries AS outbox_retries,
        l.*
      FROM sync_outbox so
      JOIN logs l ON l.id = so.log_id
      WHERE so.id = ANY($1::bigint[])
      ORDER BY so.id
    `,
    [outboxIds]
  );

  return logs.rows;
}

async function releaseToPending(client, outboxIds) {
  if (!outboxIds || outboxIds.length === 0) return;

  await client.query(
    `
      UPDATE sync_outbox
      SET
        status = 'pending',
        batch_id = NULL,
        locked_at = NULL,
        worker_id = NULL,
        updated_at = now()
      WHERE id = ANY($1::bigint[])
    `,
    [outboxIds]
  );
}

async function markRowsDone(client, rows, commitSha, fileByLogId) {
  for (const row of rows) {
    const mapped = fileByLogId.get(row.id) || {};
    await client.query(
      `
        UPDATE logs
        SET
          github_path = $1,
          github_blob_sha = $2,
          github_commit_sha = $3
        WHERE id = $4
      `,
      [mapped.path || row.github_path, mapped.blobSha || row.github_blob_sha, commitSha, row.id]
    );
  }

  const outboxIds = rows.map(row => row.outbox_id);
  await client.query(
    `
      UPDATE sync_outbox
      SET
        status = 'done',
        batch_id = NULL,
        locked_at = NULL,
        worker_id = NULL,
        last_error = NULL,
        updated_at = now()
      WHERE id = ANY($1::bigint[])
    `,
    [outboxIds]
  );

  await client.query(
    `
      INSERT INTO sync_state (name, last_seen_commit_sha, updated_at)
      VALUES ('github_outbound', $1, now())
      ON CONFLICT (name)
      DO UPDATE SET
        last_seen_commit_sha = EXCLUDED.last_seen_commit_sha,
        updated_at = now()
    `,
    [commitSha]
  );
}

async function markRowsFailed(client, rows, err, config) {
  const message = String(err && err.message ? err.message : 'Outbound sync failed').slice(0, 4000);

  for (const row of rows) {
    const currentRetries = Number(row.outbox_retries || 0);
    const nextRetries = currentRetries + 1;
    const delayMs = computeBackoffMs(nextRetries, err);
    const nextRetryAt = new Date(Date.now() + delayMs);
    const nextStatus = nextRetries >= config.syncMaxRetries ? 'dead' : 'failed';

    await client.query(
      `
        UPDATE sync_outbox
        SET
          status = $1,
          retries = $2,
          next_retry_at = $3,
          last_error = $4,
          batch_id = NULL,
          locked_at = NULL,
          worker_id = NULL,
          updated_at = now()
        WHERE id = $5
      `,
      [nextStatus, nextRetries, nextRetryAt, message, row.outbox_id]
    );
  }
}

function buildFiles(rows, config) {
  return rows.map(row => {
    const path = row.github_path || buildGitHubPath({
      id: row.id,
      endAt: row.end_at,
      durationMs: row.duration_ms,
      userLogin: row.user_login,
      timeZone: row.timezone || config.defaultTimeZone
    });

    return {
      logId: row.id,
      path,
      content: String(row.text || ''),
      size: Buffer.byteLength(String(row.text || ''), 'utf8')
    };
  });
}

async function runOutboundSync({ pool, github, config, logger = console }) {
  if (!github.isEnabled()) {
    return { skipped: 'github_disabled' };
  }

  const client = await pool.connect();
  let locked = false;
  let selectedRows = [];

  try {
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [OUTBOUND_LOCK_KEY]);
    locked = lockResult.rows[0] && lockResult.rows[0].locked === true;

    if (!locked) {
      return { skipped: 'lock_held' };
    }

    await ensureSyncStateRow(client, 'github_outbound');
    const recovered = await reapStaleInflight(client);

    let claimLimit = config.syncBatchMaxLogs;
    try {
      const rate = await github.getRateLimit();
      if (Number.isFinite(rate.remaining)) {
        const budget = Math.max(0, rate.remaining - config.syncRateLimitFloor - 5);
        claimLimit = Math.min(claimLimit, Math.floor(budget));
      }
    } catch (err) {
      logger.warn('[sync:outbound] rate limit check failed', err.message);
    }

    if (claimLimit <= 0) {
      return { skipped: 'rate_floor' };
    }

    const batchId = randomUUID();
    const workerId = `pid-${process.pid}`;
    const claimedRows = await claimRows(client, claimLimit, batchId, workerId);

    if (claimedRows.length === 0) {
      return { ok: true, claimed: 0, recovered };
    }

    let bytes = 0;
    selectedRows = [];
    const postponedIds = [];

    for (const row of claimedRows) {
      const text = String(row.text || '');
      const size = Buffer.byteLength(text, 'utf8');
      const nextCount = selectedRows.length + 1;
      const nextBytes = bytes + size;

      if (nextCount > config.syncBatchMaxLogs || (nextBytes > config.syncBatchMaxBytes && selectedRows.length > 0)) {
        postponedIds.push(row.outbox_id);
        continue;
      }

      selectedRows.push(row);
      bytes = nextBytes;
    }

    if (postponedIds.length > 0) {
      await releaseToPending(client, postponedIds);
    }

    if (selectedRows.length === 0) {
      return { ok: true, claimed: 0, postponed: postponedIds.length, recovered };
    }

    const files = buildFiles(selectedRows, config);
    const message = `worklog batch ${new Date().toISOString()} (${files.length} logs)`;

    try {
      const commit = await github.commitFiles(
        files.map(file => ({ path: file.path, content: file.content })),
        { message }
      );

      const fileByLogId = new Map();
      for (const file of files) {
        const blobSha = commit.blobShasByPath.get(file.path) || null;
        fileByLogId.set(file.logId, {
          path: file.path,
          blobSha
        });
      }

      await markRowsDone(client, selectedRows, commit.commitSha, fileByLogId);

      return {
        ok: true,
        claimed: selectedRows.length,
        postponed: postponedIds.length,
        bytes,
        commitSha: commit.commitSha,
        recovered
      };
    } catch (err) {
      await markRowsFailed(client, selectedRows, err, config);
      throw err;
    }
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [OUTBOUND_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

module.exports = {
  runOutboundSync
};
