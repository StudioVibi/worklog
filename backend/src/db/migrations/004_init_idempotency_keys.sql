CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_login TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  log_id TEXT NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_login, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at DESC);
