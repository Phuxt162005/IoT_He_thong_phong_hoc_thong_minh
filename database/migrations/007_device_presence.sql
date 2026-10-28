ALTER TABLE devices ADD COLUMN last_rssi_dbm SMALLINT;
ALTER TABLE devices ADD COLUMN last_free_heap_bytes BIGINT;
ALTER TABLE devices ADD COLUMN last_uptime_seconds BIGINT;
ALTER TABLE devices ADD COLUMN last_heartbeat_at TIMESTAMPTZ;
CREATE TABLE device_sessions (
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  session_id VARCHAR(64) NOT NULL,
  last_msg_id VARCHAR(64),
  last_timestamp_ms BIGINT NOT NULL,
  last_uptime_seconds BIGINT,
  last_heartbeat_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  PRIMARY KEY(device_id,session_id)
);
CREATE UNIQUE INDEX device_sessions_open_idx ON device_sessions(device_id) WHERE closed_at IS NULL;
ALTER TABLE iot_events ALTER COLUMN data_id DROP NOT NULL;
CREATE INDEX iot_events_type_time_idx ON iot_events(event_type,created_at,event_id);
