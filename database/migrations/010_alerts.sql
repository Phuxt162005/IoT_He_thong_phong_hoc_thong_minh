CREATE TABLE alert_thresholds (
  threshold_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(room_id),
  sensor_type VARCHAR(15) NOT NULL CHECK(sensor_type IN ('TEMPERATURE','HUMIDITY')),
  severity VARCHAR(10) NOT NULL CHECK(severity IN ('WARNING','CRITICAL')),
  operator VARCHAR(3) NOT NULL CHECK(operator IN ('GT','GTE')),
  threshold_value DOUBLE PRECISION NOT NULL,
  clear_value DOUBLE PRECISION NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by BIGINT REFERENCES users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(room_id,sensor_type,severity),
  CHECK(clear_value<=threshold_value),
  CHECK((sensor_type='TEMPERATURE' AND threshold_value BETWEEN -10 AND 60 AND clear_value BETWEEN -10 AND 60)
    OR (sensor_type='HUMIDITY' AND threshold_value BETWEEN 0 AND 100 AND clear_value BETWEEN 0 AND 100))
);
INSERT INTO alert_thresholds(sensor_type,severity,operator,threshold_value,clear_value) VALUES
  ('TEMPERATURE','WARNING','GTE',30,28),('TEMPERATURE','CRITICAL','GTE',35,33),
  ('HUMIDITY','WARNING','GTE',80,75),('HUMIDITY','CRITICAL','GTE',90,85);
CREATE TABLE alerts (
  alert_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  alert_type VARCHAR(20) NOT NULL CHECK(alert_type IN ('TEMP_HIGH','HUMIDITY_HIGH','DEVICE_OFFLINE','DEVICE_FAULT')),
  severity VARCHAR(10) NOT NULL CHECK(severity IN ('WARNING','CRITICAL')),
  value DOUBLE PRECISION,
  message VARCHAR(255) NOT NULL,
  status VARCHAR(15) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  clear_count INTEGER NOT NULL DEFAULT 0,
  acknowledged_by BIGINT REFERENCES users(user_id),
  acknowledged_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(user_id),
  resolved_at TIMESTAMPTZ,
  resolved_reason VARCHAR(32),
  resolution_note VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_one_open_idx ON alerts(device_id,alert_type) WHERE status<>'RESOLVED';
CREATE INDEX alerts_room_status_idx ON alerts(room_id,status,created_at DESC,alert_id DESC);
