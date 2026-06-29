-- Recent call log for /debug viewer and local outcome anchoring.

CREATE TABLE IF NOT EXISTS call_log (
  id                  TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  path                TEXT,
  model               TEXT,
  provider            TEXT,
  short_circuited_by  TEXT,
  module_chain        TEXT,
  metadata            TEXT,
  user_query          TEXT,
  response_excerpt    TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  tokens_saved        INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS call_log_created_at_idx ON call_log (created_at DESC);

CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  call_id     TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  source      TEXT NOT NULL,
  score       REAL,
  labels      TEXT,
  notes_hash  TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (call_id) REFERENCES call_log (id)
);

CREATE INDEX IF NOT EXISTS outcomes_call_id_idx ON outcomes (call_id);