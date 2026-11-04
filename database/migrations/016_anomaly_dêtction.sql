
-- Baseline được lưu riêng theo từng thiết bị và chỉ số cảm biến.
-- Mỗi baseline giữ tối đa 30 mẫu gần nhất để phục vụ Robust Z-score.
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

-- Lưu một kết quả phân tích cho mỗi bản ghi telemetry.
-- findings chứa kết quả chi tiết của từng chỉ số được phân tích.
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

-- Phục vụ truy vấn kết quả bất thường theo thời gian.
CREATE INDEX anomaly_results_detected_time_idx
  ON anomaly_detection_results(analyzed_at DESC)
  WHERE anomaly_detected = true;

CREATE INDEX anomaly_results_room_time_idx
  ON anomaly_detection_results(room_id, analyzed_at DESC);

CREATE INDEX anomaly_results_device_time_idx
  ON anomaly_detection_results(device_id, analyzed_at DESC);
