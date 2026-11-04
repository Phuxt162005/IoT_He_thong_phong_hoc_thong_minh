import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture } from "../helpers/iot.js";
import { TelemetryPipeline } from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";
import { AnomalyDetectionConsumer } from "../../backend/src/modules/anomaly-detection/anomaly-detection.consumer.js";

test("telemetry được phân tích, lưu baseline và lưu kết quả bất thường bằng PostgreSQL", async (t) => {
  const f = await iotFixture(t);
  const sensor = await f.activateSensor();
  const pipeline = new TelemetryPipeline({ pool: f.pool, mqtt: f.runtime, logger: f.logger });
  const consumer = new AnomalyDetectionConsumer({ pool: f.pool, logger: f.logger });
  const values = [25.0, 25.1, 24.9, 25.2, 25.0, 25.1, 24.8, 25.0, 45.0];

  for (let i = 0; i < values.length; i++) {
    const payload = {
      msg_id: `ANOMALY_${i}`,
      device_id: sensor.device.device_code,
      room_id: f.room.room_code,
      timestamp: Date.now() + i,
      data: { temperature: values[i], humidity: 60, lux: 300, occupancy: true },
    };
    await pipeline.ingest({
      topic: `smartclassroom/room/${f.room.room_code}/device/${sensor.device.device_code}/telemetry`,
      kind: "telemetry",
      deviceCode: sensor.device.device_code,
      roomCode: f.room.room_code,
      payload,
    });
    await consumer.consumePending();
  }

  const baseline = (await f.pool.query(
    "SELECT samples FROM anomaly_baselines WHERE device_id=$1 AND metric='temperatureC'",
    [sensor.device.device_id],
  )).rows[0].samples;
  assert.equal(baseline.length, 8);
  assert.equal(baseline.includes(45), false);

  const results = (await f.pool.query(
    "SELECT msg_id, anomaly_detected, result FROM anomaly_detection_results WHERE device_id=$1 ORDER BY result_id",
    [sensor.device.device_id],
  )).rows;
  assert.equal(results.length, 9);
  assert.equal(results.at(-1).msg_id, "ANOMALY_8");
  assert.equal(results.at(-1).anomaly_detected, true);
  assert.equal(results.at(-1).result.findings[0].status, "ANOMALY");

  assert.equal(await consumer.consumePending(), 0);
  assert.equal((await f.pool.query(
    "SELECT count(*) FROM anomaly_detection_results WHERE device_id=$1",
    [sensor.device.device_id],
  )).rows[0].count, "9");
});
