CREATE TABLE roles (
  role_id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_name VARCHAR(10) NOT NULL UNIQUE CHECK (role_name IN ('ADMIN','OPERATOR','VIEWER'))
);
CREATE TABLE users (
  user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_.-]{3,64}$'),
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role_id SMALLINT NOT NULL REFERENCES roles(role_id),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE rooms (
  room_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code VARCHAR(40) NOT NULL UNIQUE CHECK (room_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  room_name VARCHAR(100) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE user_rooms (
  user_id BIGINT NOT NULL REFERENCES users(user_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  PRIMARY KEY (user_id,room_id)
);
CREATE INDEX user_rooms_room_idx ON user_rooms(room_id);
CREATE TABLE devices (
  device_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_code VARCHAR(40) NOT NULL UNIQUE CHECK (device_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  device_name VARCHAR(100) NOT NULL,
  device_type VARCHAR(20) NOT NULL CHECK (device_type IN ('SENSOR_NODE','CONTROL_NODE')),
  room_id BIGINT REFERENCES rooms(room_id),
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED' CHECK (lifecycle_status IN ('REGISTERED','PROVISIONED','ACTIVE','FAULT','MAINTENANCE','REVOKED','DECOMMISSIONED')),
  connection_status VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN' CHECK (connection_status IN ('UNKNOWN','ONLINE','OFFLINE')),
  hardware_version VARCHAR(64),
  firmware_version VARCHAR(64),
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lifecycle_status = 'REGISTERED' OR room_id IS NOT NULL)
);
CREATE UNIQUE INDEX devices_room_type_idx ON devices(room_id,device_type)
  WHERE room_id IS NOT NULL AND lifecycle_status NOT IN ('REVOKED','DECOMMISSIONED');
CREATE INDEX devices_presence_idx ON devices(connection_status,last_seen);
CREATE TABLE audit_logs (
  log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('USER','DEVICE','SYSTEM')),
  actor_id BIGINT,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(64),
  result VARCHAR(10) NOT NULL CHECK (result IN ('SUCCESS','FAILURE','DENIED')),
  request_id VARCHAR(64),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx ON audit_logs(created_at DESC,log_id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id,created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type,target_id);
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
