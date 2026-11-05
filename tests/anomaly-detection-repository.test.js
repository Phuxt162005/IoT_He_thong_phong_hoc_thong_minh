import test from "node:test";
import assert from "node:assert/strict";
import { PostgresAnomalyRepository } from "../backend/src/modules/anomaly-detection/anomaly-detection.repository.pg.js";

function fixture(row = null) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };

  return {
    repository: new PostgresAnomalyRepository({
      client,
      dataId: "1001",
      deviceId: "10",
      roomId: "20",
    }),
    queries,
  };
}

const recordedAt = new Date("2026-11-04T10:00:00.000Z");
const analyzedAt = new Date("2026-11-04T10:00:02.000Z");

function processedRow(overrides = {}) {
  return {
    data_id: "1001",
    device_id: "10",
    room_id: "20",
    anomaly_detected: true,
    findings: [{ metric: "temperatureC", value: 45, status: "ANOMALY" }],
    analyzed_at: analyzedAt,
    recorded_at: recordedAt,
    ...overrides,
  };
}

test("getProcessedEvent trả về đúng timestamp từ sensor_data", async () => {
  const { repository, queries } = fixture(processedRow());

  const result = await repository.getProcessedEvent("10", "1001");

  assert.equal(result.eventId, "1001");
  assert.equal(result.deviceId, "10");
  assert.equal(result.timestamp, recordedAt.toISOString());
  assert.equal(result.analyzedAt, analyzedAt.toISOString());
  assert.equal(result.anomalyDetected, true);
  assert.deepEqual(result.findings, processedRow().findings);
  assert.equal(result.duplicate, false);

  assert.match(queries[0].sql, /JOIN sensor_data s ON s\.data_id=r\.data_id/);
  assert.deepEqual(queries[0].params, ["1001"]);
});

test("getProcessedEvent trả null khi không tìm thấy kết quả", async () => {
  const { repository } = fixture(null);

  const result = await repository.getProcessedEvent("10", "9999");

  assert.equal(result, null);
});

test("getProcessedEvent từ chối khi sự kiện thuộc thiết bị khác", async () => {
  const { repository } = fixture(processedRow({ device_id: "99" }));

  await assert.rejects(
    () => repository.getProcessedEvent("10", "1001"),
    /ANOMALY_EVENT_DEVICE_MISMATCH/,
  );
});

test("getProcessedEvent không truy vấn khi eventId không tồn tại", async () => {
  const { reposieetory, queries } = fixture(processedRow());

  const result = await repository.getProcessedEvent("10", null);

  assert.equal(result, null);
  assert.equal(queries.length, 0);
});
