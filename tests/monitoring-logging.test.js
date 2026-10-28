import test from "node:test";
import assert from "node:assert/strict";
import { LoggingService } from "../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../backend/src/modules/monitoring-logging/logging.sinks.js";
import { InMemoryMonitoringRepository } from "../backend/src/modules/monitoring-logging/monitoring.repository.memory.js";
import { MonitoringService } from "../backend/src/modules/monitoring-logging/monitoring.service.js";

function fixture() {
  let clock = "2026-10-28T12:00:00.000Z";
  const now = () => clock;
  const sink = new MemoryLogSink();
  const logger = new LoggingService({ sink, now });
  const repository = new InMemoryMonitoringRepository();
  const monitoring = new MonitoringService({
    repository,
    logger,
    now,
    offlineAfterMs: 60000,
  });
  return {
    sink,
    repository,
    logger,
    monitoring,
    setTime: (value) => {
      clock = value;
    },
  };
}

test("logger ghi log JSON có cấu trúc", () => {
  const { sink, logger } = fixture();
  logger.info("Telemetry received", { deviceId: "SENSOR_01" });

  const entries = sink.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "INFO");
  assert.equal(entries[0].message, "Telemetry received");
  assert.equal(entries[0].metadata.deviceId, "SENSOR_01");
});

test("logger che trường nhạy cảm", () => {
  const { sink, logger } = fixture();
  logger.info("MQTT connected", {
    username: "sensor",
    password: "secret-value",
    nested: { accessToken: "token-value" },
  });

  const [entry] = sink.getEntries();
  assert.equal(entry.metadata.password, "[REDACTED]");
  assert.equal(entry.metadata.nested.accessToken, "[REDACTED]");
});

test("từ chối log level và message không hợp lệ", () => {
  const { logger } = fixture();
  assert.throws(() => logger.log("TRACE", "message"), TypeError);
  assert.throws(() => logger.info(""), TypeError);
});

test("cập nhật trạng thái component", async () => {
  const { monitoring } = fixture();
  const result = await monitoring.setComponentStatus("mqtt-broker", "UP", {
    host: "localhost",
  });

  assert.equal(result.status, "UP");
  const snapshot = await monitoring.getSnapshot();
  assert.equal(snapshot.components.length, 1);
  assert.equal(snapshot.components[0].name, "mqtt-broker");
});

test("heartbeat được tính online và chuyển offline khi quá ngưỡng", async () => {
  const { monitoring, setTime } = fixture();
  await monitoring.recordHeartbeat("SENSOR_01");

  let snapshot = await monitoring.getSnapshot();
  assert.equal(snapshot.summary.deviceOnline, 1);

  setTime("2026-10-28T12:01:01.000Z");
  snapshot = await monitoring.getSnapshot();
  assert.equal(snapshot.summary.deviceOffline, 1);
});

test("đếm sự kiện và ghi log tương ứng", async () => {
  const { monitoring, sink } = fixture();
  assert.equal(await monitoring.recordEvent("telemetry.received"), 1);
  assert.equal(
    await monitoring.recordEvent("telemetry.received", { amount: 2 }),
    3,
  );

  const snapshot = await monitoring.getSnapshot();
  assert.equal(snapshot.counters["telemetry.received"], 3);
  assert.equal(sink.getEntries().length, 2);
});

test("từ chối heartbeat timestamp không hợp lệ", async () => {
  const { monitoring } = fixture();
  await assert.rejects(
    () => monitoring.recordHeartbeat("SENSOR_01", {}, "not-a-date"),
    (error) => error.code === "INVALID_TIMESTAMP",
  );
});

test("từ chối trạng thái component và amount không hợp lệ", async () => {
  const { monitoring } = fixture();

  await assert.rejects(
    () => monitoring.setComponentStatus("mqtt-broker", "ONLINE"),
    (error) => error.code === "INVALID_STATUS",
  );

  await assert.rejects(
    () => monitoring.recordEvent("telemetry.received", { amount: 1.5 }),
    (error) => error.code === "INVALID_AMOUNT",
  );
});
