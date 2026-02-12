CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  last_seen_commit_sha TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sync_state (name)
VALUES ('github_inbound')
ON CONFLICT (name) DO NOTHING;

INSERT INTO sync_state (name)
VALUES ('github_outbound')
ON CONFLICT (name) DO NOTHING;
