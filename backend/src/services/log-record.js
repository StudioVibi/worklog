const { buildGitHubPath } = require('./log-path');

function toApiLog(row, { defaultTimeZone }) {
  const timezone = row.timezone || defaultTimeZone;
  const endAt = row.end_at instanceof Date ? row.end_at : new Date(row.end_at);
  const path = row.github_path || buildGitHubPath({
    id: row.id,
    endAt,
    durationMs: row.duration_ms,
    userLogin: row.user_login,
    timeZone: timezone
  });

  return {
    id: row.id,
    path,
    userLogin: row.user_login,
    startAt: row.start_at instanceof Date ? row.start_at.toISOString() : new Date(row.start_at).toISOString(),
    endAt: endAt.toISOString(),
    durationMs: Number(row.duration_ms),
    text: row.text,
    timezone,
    source: row.source,
    githubPath: row.github_path,
    githubBlobSha: row.github_blob_sha,
    githubCommitSha: row.github_commit_sha,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
  };
}

module.exports = {
  toApiLog
};
