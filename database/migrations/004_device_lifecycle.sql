-- An unassigned REGISTERED device may be retired without inventing a room.
ALTER TABLE devices DROP CONSTRAINT devices_check;
ALTER TABLE devices ADD CONSTRAINT devices_room_required CHECK(lifecycle_status IN ('REGISTERED','DECOMMISSIONED') OR room_id IS NOT NULL);
ALTER TABLE devices ADD COLUMN fault_counters JSONB NOT NULL DEFAULT '{}';
CREATE TABLE actuators (
  actuator_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  actuator_type VARCHAR(10) NOT NULL CHECK(actuator_type IN ('LIGHT','FAN')),
  desired_state VARCHAR(3) NOT NULL DEFAULT 'OFF' CHECK(desired_state IN ('ON','OFF')),
  current_state VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN' CHECK(current_state IN ('ON','OFF','UNKNOWN')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(device_id,actuator_type)
);
CREATE TABLE device_lifecycle_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  actor_type VARCHAR(10) NOT NULL CHECK(actor_type IN ('USER','SYSTEM')),
  actor_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_status IS NULL OR from_status IN ('REGISTERED','PROVISIONED','ACTIVE','FAULT','MAINTENANCE','REVOKED','DECOMMISSIONED')),
  CHECK (to_status IN ('REGISTERED','PROVISIONED','ACTIVE','FAULT','MAINTENANCE','REVOKED','DECOMMISSIONED'))
);
CREATE INDEX device_lifecycle_time_idx ON device_lifecycle_events(device_id,created_at DESC,event_id DESC);
CREATE TRIGGER device_lifecycle_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON device_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
