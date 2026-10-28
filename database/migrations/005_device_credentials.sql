ALTER TABLE devices ADD COLUMN broker_sync_status VARCHAR(10) NOT NULL DEFAULT 'NONE' CHECK(broker_sync_status IN ('NONE','PENDING','SYNCED'));
ALTER TABLE devices ADD COLUMN session_id VARCHAR(64);
CREATE TABLE device_credentials (
  credential_id UUID PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  version INTEGER NOT NULL CHECK(version > 0),
  mqtt_username VARCHAR(40) NOT NULL,
  secret_hash TEXT NOT NULL,
  status VARCHAR(10) NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  UNIQUE(device_id,version)
);
CREATE UNIQUE INDEX device_credentials_active_idx ON device_credentials(device_id) WHERE status='ACTIVE';
CREATE TABLE broker_operations (
  operation_id UUID PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  credential_id UUID REFERENCES device_credentials(credential_id),
  operation VARCHAR(10) NOT NULL CHECK(operation IN ('PROVISION','ROTATE','REVOKE')),
  secret_encrypted TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','SUPERSEDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX broker_operations_pending_device_idx ON broker_operations(device_id) WHERE status='PENDING';
CREATE INDEX broker_operations_retry_idx ON broker_operations(next_retry_at) WHERE status='PENDING';
