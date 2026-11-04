import test from "node:test";
import assert from "node:assert/strict";
import { LoggingService } from "../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../backend/src/modules/monitoring-logging/logging.sinks.js";
import { InMemoryMonitoringRepository } from "../backend/src/modules/monitoring-logging/monitoring.repository.memory.js";
import { MonitoringService } from "../backend/src/modules/monitoring-logging/monitoring.service.js";
import { PostgresMonitoringRepository } from "../backend/src/modules/monitoring-logging/monitoring.repository.postgres.js";

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

test("không tăng counter khi log level không hợp lệ", async () => {
  const { monitoring } = fixture();

  await assert.rejects(
    () => monitoring.recordEvent("telemetry.received", { level: "TRACE" }),
    (error) => error.code === "INVALID_LOG_LEVEL",
  );

  const snapshot = await monitoring.getSnapshot();
  assert.equal(snapshot.counters["telemetry.received"], undefined);
});

test("PostgreSQL repository lưu trạng thái component", async () => {
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return {
        rows: [
          {
            name: params[0],
            status: params[1],
            details: JSON.parse(params[2]),
            updated_at: params[3],
          },
        ],
      };
    },
  };

  const repository = new PostgresMonitoringRepository(pool);
  const result = await repository.setComponent(
    "mqtt-broker",
    "UP",
    { connected: true },
    "2026-11-04T12:00:00.000Z",
  );

  assert.equal(result.name, "mqtt-broker");
  assert.equal(result.status, "UP");
  assert.equal(result.details.connected, true);
  assert.match(captured.sql, /ON CONFLICT\(name\) DO UPDATE/);
});

test("PostgreSQL repository đọc trạng thái thiết bị từ bảng devices", async () => {
  const pool = {
    async query(sql) {
      assert.match(sql, /FROM devices/);
      assert.match(sql, /connection_status/);
      return {
        rows: [
          {
            deviceId: "SENSOR_01",
            connectionStatus: "ONLINE",
            lifecycleStatus: "ACTIVE",
            lastSeenAt: "2026-11-04T12:00:00.000Z",
            roomId: "1",
          },
        ],
      };
    },
  };

  const repository = new PostgresMonitoringRepository(pool);
  const devices = await repository.getDevices();

  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, "SENSOR_01");
  assert.equal(devices[0].connectionStatus, "ONLINE");
});

test("PostgreSQL repository tăng counter bằng thao tác upsert", async () => {
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ value: "12" }] };
    },
  };

  const repository = new PostgresMonitoringRepository(pool);
  const value = await repository.incrementCounter("mqtt.telemetry.received", 2);

  assert.equal(value, 12);
  assert.equal(captured.params[0], "mqtt.telemetry.received");
  assert.equal(captured.params[1], 2);
  assert.match(captured.sql, /monitoring_counters\.value\+EXCLUDED\.value/);
});
