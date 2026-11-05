CREATE TABLE monitoring_logs (
  log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL,
  level VARCHAR(8) NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR')),
  service VARCHAR(100) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX monitoring_logs_time_idx
  ON monitoring_logs(logged_at DESC, log_id DESC);

CREATE INDEX monitoring_logs_level_time_idx
  ON monitoring_logs(level, logged_at DESC, log_id DESC);

CREATE INDEX monitoring_logs_service_time_idx
  ON monitoring_logs(service, logged_at DESC, log_id DESC);