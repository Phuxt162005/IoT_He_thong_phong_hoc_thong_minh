import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetryRepository } from "../backend/src/modules/telemetry-ingestion/telemetry-ingestion.repository.memory.js";
import { TelemetryIngestionService } from "../backend/src/modules/telemetry-ingestion/telemetry-ingestion.service.js";

function fixture() {
  const repository = new InMemoryTelemetryRepository();
  const service = new TelemetryIngestionService({
    repository,
    now: () => "2026-10-28T10:00:00.000Z",
  });
  return { repository, service };
}

function sample(eventId = "SENSOR_01-BOOT1-ABC-1") {
  return {
    messageType: "telemetry",
    eventId,
    deviceId: "SENSOR_01",
    roomCode: "ROOM_302",
    timestamp: "2026-10-28T09:59:55Z",
    temperatureC: 27.5,
    humidityPercent: 65,
    illuminanceLux: 320,
  };
}

test("lưu telemetry mới và trả ACK STORED", async () => {
  const { repository, service } = fixture();
  const result = await service.ingest(sample());

  assert.equal(result.status, "STORED");
  assert.equal(result.duplicate, false);
  assert.equal(await repository.count(), 1);
});

test("bản tin gửi lại không tạo dữ liệu trùng", async () => {
  const { repository, service } = fixture();
  await service.ingest(sample());
  const retry = await service.ingest(sample());

  assert.equal(retry.status, "STORED");
  assert.equal(retry.duplicate, true);
  assert.equal(await repository.count(), 1);
});

test("ACK có eventId khớp bản tin", async () => {
  const { service } = fixture();
  const result = await service.ingest(sample());
  const ack = service.buildAck(result);

  assert.equal(ack.messageType, "telemetry_ack");
  assert.equal(ack.eventId, "SENSOR_01-BOOT1-ABC-1");
  assert.equal(ack.status, "STORED");
});

test("từ chối payload thiếu eventId", async () => {
  const { service } = fixture();
  const payload = sample();
  delete payload.eventId;

  await assert.rejects(
    () => service.ingest(payload),
    (error) => error.code === "MISSING_FIELD",
  );
});

test("từ chối dữ liệu cảm biến không hợp lệ", async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.ingest({ ...sample(), humidityPercent: 120 }),
    (error) => error.code === "OUT_OF_RANGE",
  );

  await assert.rejects(
    () => service.ingest({ ...sample(), temperatureC: "27.5" }),
    (error) => error.code === "INVALID_MEASUREMENT",
  );
});

test("eventId khác nhau được lưu thành các bản ghi riêng", async () => {
  const { repository, service } = fixture();
  await service.ingest(sample("EVENT_1"));
  await service.ingest(sample("EVENT_2"));

  assert.equal(await repository.count(), 2);
});
