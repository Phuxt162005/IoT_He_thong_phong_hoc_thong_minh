CREATE TABLE device_settings (
  device_id BIGINT PRIMARY KEY REFERENCES devices(device_id),
  desired_version INTEGER NOT NULL DEFAULT 0,
  applied_version INTEGER NOT NULL DEFAULT 0,
  desired_settings JSONB NOT NULL,
  applied_settings JSONB NOT NULL DEFAULT '{}',
  last_error_code VARCHAR(40),
  last_applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO device_settings(device_id,desired_settings)
  SELECT device_id,CASE WHEN device_type='SENSOR_NODE'
    THEN '{"sample_interval_seconds":5,"heartbeat_interval_seconds":10}'::jsonb
    ELSE '{"heartbeat_interval_seconds":10}'::jsonb END FROM devices;
CREATE TABLE device_configs (
  config_id UUID PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  version INTEGER NOT NULL,
  settings JSONB NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  credential_version INTEGER NOT NULL,
  requested_by BIGINT NOT NULL REFERENCES users(user_id),
  requested_token_version INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCESS','FAILED','TIMEOUT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  timeout_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  late_ack_at TIMESTAMPTZ,
  error_code VARCHAR(40),
  UNIQUE(device_id,version)
);
CREATE INDEX device_configs_pending_idx ON device_configs(timeout_at) WHERE status='PENDING';
CREATE INDEX device_configs_history_idx ON device_configs(device_id,version DESC);
