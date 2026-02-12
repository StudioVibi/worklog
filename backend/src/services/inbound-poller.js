const { randomUUID } = require('crypto');
const { parseLogPath } = require('./log-path');
const { createContentHash } = require('./hash');

const INBOUND_LOCK_KEY = 8201002;

async function ensureSyncStateRow(client, name) {
  await client.query(
    `INSERT INTO sync_state (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name]
  );
}

async function getCursor(client, name) {
  const result = await client.query(
    `SELECT last_seen_commit_sha FROM sync_state WHERE name = $1`,
    [name]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0].last_seen_commit_sha || null;
}

async function setCursor(client, name, sha) {
  await client.query(
    `
      INSERT INTO sync_state (name, last_seen_commit_sha, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (name)
      DO UPDATE SET
        last_seen_commit_sha = EXCLUDED.last_seen_commit_sha,
        updated_at = now()
    `,
    [name, sha]
  );
}

function compareFilesToTargets(compareData) {
  const files = compareData && Array.isArray(compareData.files) ? compareData.files : [];
  return files
    .filter(file => file && file.filename && file.filename.startsWith('logs/'))
    .filter(file => file.status !== 'removed')
    .filter(file => file.sha)
    .map(file => ({
      path: file.filename,
      sha: file.sha
    }));
}

async function upsertGitHubLog(client, file, parsed, text, commitSha, config) {
  const hash = createContentHash(text);

  const result = await client.query(
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
        github_blob_sha,
        github_commit_sha,
        content_sha256,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        'github_poller',
        $8,
        $9,
        $10,
        $11,
        now()
      )
      ON CONFLICT (github_path)
      DO UPDATE SET
        text = EXCLUDED.text,
        content_sha256 = EXCLUDED.content_sha256,
        github_blob_sha = EXCLUDED.github_blob_sha,
        github_commit_sha = EXCLUDED.github_commit_sha,
        source = 'github_poller'
      WHERE logs.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256
         OR logs.github_blob_sha IS DISTINCT FROM EXCLUDED.github_blob_sha
         OR logs.github_commit_sha IS DISTINCT FROM EXCLUDED.github_commit_sha
      RETURNING id
    `,
    [
      randomUUID(),
      parsed.userLogin,
      parsed.startAt,
      parsed.endAt,
      parsed.durationMs,
      text,
      config.defaultTimeZone,
      file.path,
      file.sha,
      commitSha,
      hash
    ]
  );

  return result.rowCount > 0;
}

async function importFiles(client, files, commitSha, github, config, logger = console) {
  const result = {
    processed: 0,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0
  };

  for (const file of files) {
    result.processed += 1;

    const parsed = parseLogPath(file.path, {
      defaultDurationMs: config.defaultIntervalMs,
      timeZone: config.defaultTimeZone
    });

    if (!parsed) {
      result.skipped += 1;
      continue;
    }

    try {
      const text = await github.getBlobContent(file.sha);
      const changed = await upsertGitHubLog(client, file, parsed, text, commitSha, config);
      if (changed) {
        result.imported += 1;
      } else {
        result.unchanged += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.warn(`[sync:inbound] failed importing ${file.path}: ${err.message}`);
    }
  }

  return result;
}

async function loadAllFromTree(github, branch) {
  const entries = await github.listLogsTree(branch);
  return entries
    .filter(entry => entry && entry.path && entry.sha)
    .map(entry => ({ path: entry.path, sha: entry.sha }));
}

async function runInboundPoll({ pool, github, config, logger = console }) {
  if (!github.isEnabled()) {
    return { skipped: 'github_disabled' };
  }

  const client = await pool.connect();
  let locked = false;

  try {
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [INBOUND_LOCK_KEY]);
    locked = lockResult.rows[0] && lockResult.rows[0].locked === true;

    if (!locked) {
      return { skipped: 'lock_held' };
    }

    await ensureSyncStateRow(client, 'github_inbound');

    const head = await github.getHeadCommit();
    const cursor = await getCursor(client, 'github_inbound');

    if (!head || !head.commitSha) {
      return { skipped: 'no_head' };
    }

    let files = [];
    let mode = 'incremental';

    if (!cursor) {
      mode = 'full_initial';
      files = await loadAllFromTree(github, head.branch);
    } else if (cursor === head.commitSha) {
      return {
        ok: true,
        mode: 'noop',
        head: head.commitSha,
        processed: 0
      };
    } else {
      try {
        const compare = await github.compareCommits(cursor, head.commitSha);
        const status = compare && compare.status;

        if ((status === 'ahead' || status === 'identical')) {
          files = compareFilesToTargets(compare);
          if (files.length > 300) {
            mode = 'full_fallback';
            files = await loadAllFromTree(github, head.branch);
          }
        } else {
          mode = 'full_fallback';
          files = await loadAllFromTree(github, head.branch);
        }
      } catch (err) {
        mode = 'full_fallback';
        files = await loadAllFromTree(github, head.branch);
      }
    }

    const imported = await importFiles(client, files, head.commitSha, github, config, logger);
    await setCursor(client, 'github_inbound', head.commitSha);

    return {
      ok: true,
      mode,
      head: head.commitSha,
      ...imported
    };
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [INBOUND_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

module.exports = {
  runInboundPoll
};
