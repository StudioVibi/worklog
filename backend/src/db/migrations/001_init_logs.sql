CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  text TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  source TEXT NOT NULL CHECK (source IN ('api', 'github_poller')),
  github_path TEXT UNIQUE,
  github_blob_sha TEXT,
  github_commit_sha TEXT,
  content_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_user_end_at ON logs (user_login, end_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_content_sha256 ON logs (content_sha256);
