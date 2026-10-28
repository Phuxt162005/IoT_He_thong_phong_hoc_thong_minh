ALTER TABLE actuators ADD COLUMN desired_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE actuators ADD COLUMN reported_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actuators ADD COLUMN reported_session_id VARCHAR(64);
ALTER TABLE actuators ADD COLUMN reported_timestamp_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN manual_override_until TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN control_mode VARCHAR(10) NOT NULL DEFAULT 'AUTO' CHECK(control_mode IN ('AUTO','MANUAL'));
CREATE TABLE device_shadows (
  device_id BIGINT PRIMARY KEY REFERENCES devices(device_id),
  desired_state JSONB NOT NULL DEFAULT '{"light":"OFF","fan":"OFF"}',
  reported_state JSONB NOT NULL DEFAULT '{"light":"UNKNOWN","fan":"UNKNOWN"}',
  desired_version INTEGER NOT NULL DEFAULT 1,
  reported_version INTEGER NOT NULL DEFAULT 0,
  last_reported_at TIMESTAMPTZ,
  last_command_error VARCHAR(40),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO device_shadows(device_id) SELECT device_id FROM devices WHERE device_type='CONTROL_NODE';
CREATE TABLE commands (
  command_id UUID PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  desired_state JSONB NOT NULL,
  shadow_version INTEGER NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  credential_version INTEGER NOT NULL,
  source VARCHAR(10) NOT NULL CHECK(source IN ('MANUAL','AUTOMATION')),
  requested_by BIGINT REFERENCES users(user_id),
  requested_token_version INTEGER,
  rule_id BIGINT,
  request_id VARCHAR(64),
  status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCESS','FAILED','TIMEOUT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  timeout_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  late_ack_at TIMESTAMPTZ,
  error_code VARCHAR(40),
  ack_payload JSONB,
  CHECK((source='MANUAL' AND requested_by IS NOT NULL AND requested_token_version IS NOT NULL AND rule_id IS NULL)
    OR (source='AUTOMATION' AND requested_by IS NULL AND requested_token_version IS NULL AND rule_id IS NOT NULL)),
  UNIQUE(device_id,shadow_version)
);
CREATE INDEX commands_timeout_idx ON commands(timeout_at) WHERE status='PENDING';
CREATE INDEX commands_unpublished_idx ON commands(created_at) WHERE status='PENDING' AND published_at IS NULL;
CREATE INDEX commands_history_idx ON commands(device_id,created_at DESC,command_id);
CREATE TABLE command_idempotency (
  user_id BIGINT NOT NULL REFERENCES users(user_id),
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  key VARCHAR(64) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  command_id UUID NOT NULL REFERENCES commands(command_id),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id,device_id,key)
);
CREATE INDEX command_idempotency_expiry_idx ON command_idempotency(expires_at);
