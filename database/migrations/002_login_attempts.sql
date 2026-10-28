CREATE TABLE login_attempts (
  login_key CHAR(64) PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_window_idx ON login_attempts(window_started);
