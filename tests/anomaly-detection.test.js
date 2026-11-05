import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAnomalyRepository } from "../backend/src/modules/anomaly-detection/anomaly-detection.repository.memory.js";
import { AnomalyDetectionService } from "../backend/src/modules/anomaly-detection/anomaly-detection.service.js";

function fixture(options = {}) {
  const repository = new InMemoryAnomalyRepository();
  const service = new AnomalyDetectionService({
    repository,
    now: () => "2026-10-28T12:00:00.000Z",
    minSamples: 8,
    windowSize: 30,
    threshold: 3.5,
    ...options,
  });
  return { repository, service };
}

function telemetry(eventId, temperatureC, extra = {}) {
  return {
    eventId,
    deviceId: "SENSOR_01",
    roomCode: "ROOM_302",
    timestamp: "2026-10-28T11:59:00.000Z",
    temperatureC,
    ...extra,
  };
}

test("trả WARMING_UP khi chưa đủ mẫu", async () => {
  const { service } = fixture();
  const result = await service.analyzeTelemetry(telemetry("E1", 25.0));

  assert.equal(result.findings[0].status, "WARMING_UP");
  assert.equal(result.anomalyDetected, false);
});

test("phát hiện nhiệt độ lệch khỏi baseline", async () => {
  const { service } = fixture();
  const normalValues = [25.0, 25.1, 24.9, 25.2, 25.0, 25.1, 24.8, 25.0];

  for (let i = 0; i < normalValues.length; i++) {
    await service.analyzeTelemetry(telemetry(`BASE_${i}`, normalValues[i]));
  }

  const result = await service.analyzeTelemetry(telemetry("OUTLIER_1", 45.0));
  assert.equal(result.anomalyDetected, true);
  assert.equal(result.findings[0].status, "ANOMALY");
  assert.equal(result.findings[0].reason, "ROBUST_Z_SCORE_EXCEEDED");
});

test("giá trị bình thường không bị đánh dấu bất thường", async () => {
  const { service } = fixture();
  const values = [25.0, 25.1, 24.9, 25.2, 25.0, 25.1, 24.8, 25.0];

  for (let i = 0; i < values.length; i++) {
    await service.analyzeTelemetry(telemetry(`NORMAL_${i}`, values[i]));
  }

  const result = await service.analyzeTelemetry(
    telemetry("NORMAL_NEXT", 25.05),
  );
  assert.equal(result.findings[0].status, "NORMAL");
  assert.equal(result.anomalyDetected, false);
});

test("không đưa điểm bất thường vào baseline", async () => {
  const { repository, service } = fixture();
  const values = [25.0, 25.1, 24.9, 25.2, 25.0, 25.1, 24.8, 25.0];

  for (let i = 0; i < values.length; i++) {
    await service.analyzeTelemetry(telemetry(`HIST_${i}`, values[i]));
  }

  await service.analyzeTelemetry(telemetry("SPIKE", 45.0));
  const baseline = await repository.getBaseline("SENSOR_01", "temperatureC");

  assert.equal(baseline.length, 8);
  assert.equal(baseline.includes(45.0), false);
});

test("xử lý nhiều chỉ số trong cùng một telemetry", async () => {
  const { service } = fixture();
  const result = await service.analyzeTelemetry(
    telemetry("MULTI_1", 25.0, { humidityPercent: 60, illuminanceLux: 300 }),
  );

  assert.deepEqual(
    result.findings.map((item) => item.metric),
    ["temperatureC", "humidityPercent", "illuminanceLux"],
  );
});

test("từ chối dữ liệu cảm biến không hợp lệ", async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.analyzeTelemetry(telemetry("BAD_1", "25")),
    (error) => error.code === "INVALID_MEASUREMENT",
  );

  await assert.rejects(
    () =>
      service.analyzeTelemetry(
        telemetry("BAD_2", 25, { humidityPercent: 150 }),
      ),
    (error) => error.code === "OUT_OF_RANGE",
  );
});

test("không cập nhật baseline lần hai khi nhận trùng eventId", async () => {
  const { repository, service } = fixture();
  const input = telemetry("DUPLICATE_1", 25.0);

  await service.analyzeTelemetry(input);
  const retry = await service.analyzeTelemetry(input);
  const baseline = await repository.getBaseline("SENSOR_01", "temperatureC");

  assert.equal(retry.duplicate, true);
  assert.equal(baseline.length, 1);
});

test("reset baseline của một chỉ số", async () => {
  const { repository, service } = fixture();
  await service.analyzeTelemetry(telemetry("RESET_1", 25.0));

  await service.resetBaseline("SENSOR_01", "temperatureC");
  const baseline = await repository.getBaseline("SENSOR_01", "temperatureC");

  assert.equal(baseline.length, 0);
});

test("từ chối reset với chỉ số không hỗ trợ", async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.resetBaseline("SENSOR_01", "pressure"),
    (error) => error.code === "INVALID_METRIC",
  );
});

test("từ chối telemetry thiếu eventId", async () => {
  const { service } = fixture();
  const input = telemetry("E_MISSING", 25.0);
  delete input.eventId;

  await assert.rejects(
    () => service.analyzeTelemetry(input),
    (error) => error.code === "MISSING_EVENT_ID",
  );
});

test("từ chối eventId rỗng hoặc chỉ chứa khoảng trắng", async () => {
  const { service } = fixture();

  for (const eventId of ["", "   "]) {
    await assert.rejects(
      () => service.analyzeTelemetry(telemetry(eventId, 25.0)),
      (error) => error.code === "MISSING_EVENT_ID",
    );
  }
});

test("từ chối eventId không phải chuỗi", async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.analyzeTelemetry(telemetry(123, 25.0)),
    (error) => error.code === "MISSING_EVENT_ID",
  );
});

test("từ chối nhiệt độ nằm ngoài miền hợp lệ", async () => {
  const { service } = fixture();

  for (const value of [-11, 61]) {
    await assert.rejects(
      () => service.analyzeTelemetry(telemetry(`TEMP_${value}`, value)),
      (error) => error.code === "OUT_OF_RANGE",
    );
  }
});

test("từ chối độ rọi không phải số nguyên hoặc vượt miền hợp lệ", async () => {
  const { service } = fixture();

  for (const value of [-1, 65536, 12.5]) {
    await assert.rejects(
      () =>
        service.analyzeTelemetry(
          telemetry(`LUX_${value}`, 25, { illuminanceLux: value }),
        ),
      (error) => error.code === "OUT_OF_RANGE",
    );
  }
});

test("chấp nhận nhiệt độ và độ rọi tại hai biên hợp lệ", async () => {
  const { service } = fixture();

  const result = await service.analyzeTelemetry(
    telemetry("BOUNDARY_1", -10, { illuminanceLux: 65535 }),
  );

  assert.equal(result.findings.length, 2);
  assert.equal(result.anomalyDetected, false);
});
