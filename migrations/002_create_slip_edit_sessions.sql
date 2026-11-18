CREATE TABLE slip_edit_sessions (
  line_user_id TEXT PRIMARY KEY CHECK (length(btrim(line_user_id)) > 0),
  slip_id BIGINT NOT NULL REFERENCES slips(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX slip_edit_sessions_expiry_idx ON slip_edit_sessions (expires_at);
