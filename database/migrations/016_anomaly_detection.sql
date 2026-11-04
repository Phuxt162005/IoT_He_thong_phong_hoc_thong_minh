-- Lưu baseline riêng cho từng thiết bị và từng chỉ số cảm biến.
CREATE TABLE anomaly_baselines (
  device_id BIGINT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  metric VARCHAR(32) NOT NULL CHECK (
    metric IN ('temperatureC', 'humidityPercent', 'illuminanceLux')
  ),
  samples DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
  sample_count SMALLINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, metric),
  CHECK (sample_count = cardinality(samples)),
  CHECK (sample_count BETWEEN 0 AND 30)
);

-- Mỗi bản ghi telemetry chỉ có một kết quả phân tích.
CREATE TABLE anomaly_detection_results (
  result_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_id BIGINT NOT NULL UNIQUE
    REFERENCES sensor_data(data_id) ON DELETE CASCADE,
  device_id BIGINT NOT NULL REFERENCES devices(device_id),
  room_id BIGINT NOT NULL REFERENCES rooms(room_id),
  anomaly_detected BOOLEAN NOT NULL,
  findings JSONB NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(findings) = 'array')
);

CREATE INDEX anomaly_results_detected_time_idx
  ON anomaly_detection_results(analyzed_at DESC)
  WHERE anomaly_detected = true;

CREATE INDEX anomaly_results_room_time_idx
  ON anomaly_detection_results(room_id, analyzed_at DESC);

CREATE INDEX anomaly_results_device_time_idx
  ON anomaly_detection_results(device_id, analyzed_at DESC);