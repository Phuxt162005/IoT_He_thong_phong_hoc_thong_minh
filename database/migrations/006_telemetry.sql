CREATE TABLE sensor_data (
  data_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  msg_id VARCHAR(64) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  temperature DOUBLE PRECISION NOT NULL CHECK(temperature BETWEEN -10 AND 60),
  humidity DOUBLE PRECISION NOT NULL CHECK(humidity BETWEEN 0 AND 100),
  lux DOUBLE PRECISION NOT NULL CHECK(lux BETWEEN 0 AND 65535),
  occupancy BOOLEAN,
  clock_skew BOOLEAN NOT NULL DEFAULT false,
  is_backfill BOOLEAN NOT NULL DEFAULT false,
  payload_hash CHAR(64) NOT NULL,
  UNIQUE(device_id,msg_id)
);
CREATE INDEX sensor_data_device_time_idx ON sensor_data(device_id,recorded_at DESC,data_id DESC);
CREATE INDEX sensor_data_room_time_idx ON sensor_data(room_id,recorded_at DESC,data_id DESC);
CREATE INDEX sensor_data_retention_idx ON sensor_data(recorded_at);
CREATE TABLE telemetry_latest (
  device_id BIGINT PRIMARY KEY REFERENCES devices(device_id),
  data_id BIGINT NOT NULL REFERENCES sensor_data(data_id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE iot_events (
  event_id UUID PRIMARY KEY,
  data_id BIGINT NOT NULL UNIQUE REFERENCES sensor_data(data_id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE iot_event_deliveries (
  event_id UUID NOT NULL REFERENCES iot_events(event_id) ON DELETE CASCADE,
  consumer VARCHAR(32) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,consumer)
);
