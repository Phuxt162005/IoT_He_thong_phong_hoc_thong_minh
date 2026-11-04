CREATE TABLE anomaly_baselines (
  device_id BIGINT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  metric VARCHAR(32) NOT NULL CHECK (metric IN ('temperatureC','humidityPercent','illuminanceLux')),
  samples DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(device_id, metric),
  CHECK (cardinality(samples) <= 30)
);

CREATE TABLE anomaly_detection_results (
  result_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_id BIGINT NOT NULL UNIQUE REFERENCES sensor_data(data_id) ON DELETE CASCADE,
  device_id BIGINT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  msg_id VARCHAR(64) NOT NULL,
  anomaly_detected BOOLEAN NOT NULL,
  result JSONB NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(device_id, msg_id)
);

CREATE INDEX anomaly_results_device_time_idx
  ON anomaly_detection_results(device_id, analyzed_at DESC, result_id DESC);
CREATE INDEX anomaly_results_detected_idx
  ON anomaly_detection_results(analyzed_at DESC)
  WHERE anomaly_detected = true;