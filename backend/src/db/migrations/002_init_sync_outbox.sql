CREATE TABLE IF NOT EXISTS sync_outbox (
  id BIGSERIAL PRIMARY KEY,
  log_id TEXT NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'inflight', 'done', 'failed', 'dead')),
  batch_id TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_unique_active_log
  ON sync_outbox (log_id)
  WHERE status IN ('pending', 'inflight', 'failed');

CREATE INDEX IF NOT EXISTS idx_sync_outbox_ready
  ON sync_outbox (status, next_retry_at, id);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_locked_at
  ON sync_outbox (locked_at);
