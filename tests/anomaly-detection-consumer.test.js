import test from "node:test";
import assert from "node:assert/strict";
import { AnomalyDetectionConsumer } from "../backend/src/modules/anomaly-detection/anomaly-detection.consumer.js";

const CONSUMER = "anomaly_detection";

function fixture(overrides = {}) {
  const state = {
    latestDataId: "1001",
    event: {
      event_id: "event-001",
      data_id: "1001",
      event_type: "telemetry.stored",
      payload: {
        eligible: true,
        is_latest: true,
        is_backfill: false,
        clock_skew: false,
      },
    },
    sample: {
      data_id: "1001",
      device_id: "10",
      room_id: "20",
      recorded_at: new Date("2026-11-04T10:00:00.000Z"),
      temperature: 25,
      humidity: 60,
      lux: 300,
      is_backfill: false,
      clock_skew: false,
    },
    device: { lifecycle_status: "ACTIVE" },
    room: { status: "ACTIVE" },
    deliveries: new Set(),
    baselines: new Map(),
    results: new Map(),
    failResultInsert: false,
  };

  Object.assign(state, overrides);

  const clone = (value) => structuredClone(value);
  let snapshot;

  const client = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();

      if (q === "BEGIN") {
        snapshot = {
          deliveries: new Set(state.deliveries),
          baselines: clone(state.baselines),
          results: clone(state.results),
        };
        return { rows: [], rowCount: 0 };
      }
      if (q === "COMMIT") return { rows: [], rowCount: 0 };
      if (q === "ROLLBACK") {
        state.deliveries = snapshot.deliveries;
        state.baselines = snapshot.baselines;
        state.results = snapshot.results;
        return { rows: [], rowCount: 0 };
      }

      if (q.includes("FROM iot_events") && q.includes("FOR UPDATE")) {
        return { rows: [state.event], rowCount: 1 };
      }
      if (q.includes("FROM iot_event_deliveries")) {
        const exists = state.deliveries.has(params[0]);
        return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      }
      if (q.includes("FROM sensor_data")) {
        return {
          rows: state.sample ? [state.sample] : [],
          rowCount: state.sample ? 1 : 0,
        };
      }
      if (q.includes("FROM devices")) {
        return {
          rows: state.device ? [state.device] : [],
          rowCount: state.device ? 1 : 0,
        };
      }
      if (q.includes("FROM rooms")) {
        return {
          rows: state.room ? [state.room] : [],
          rowCount: state.room ? 1 : 0,
        };
      }
      if (q.includes("FROM anomaly_baselines")) {
        const key = `${params[0]}:${params[1]}`;
        return {
          rows: state.baselines.has(key)
            ? [{ samples: state.baselines.get(key) }]
            : [],
          rowCount: state.baselines.has(key) ? 1 : 0,
        };
      }
      if (q.includes("INSERT INTO anomaly_baselines")) {
        const key = `${params[0]}:${params[1]}`;
        state.baselines.set(key, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (q.includes("FROM anomaly_detection_results")) {
        const row = state.results.get(String(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (q.includes("INSERT INTO anomaly_detection_results")) {
        if (state.failResultInsert)
          throw new Error("SIMULATED_DATABASE_FAILURE");
        state.results.set(String(params[0]), {
          data_id: params[0],
          device_id: params[1],
          room_id: params[2],
          anomaly_detected: params[3],
          findings: JSON.parse(params[4]),
          analyzed_at: new Date(params[5]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.includes("INSERT INTO iot_event_deliveries")) {
        state.deliveries.add(params[0]);
        return { rows: [], rowCount: 1 };
      }

      if (q.includes("FROM telemetry_latest")) {
        return {
          rows: [{ data_id: state.latestDataId }],
          rowCount: 1,
        };
      }

      throw new Error(`SQL chưa được mock: ${q}`);
    },
  };

  const pool = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q.includes("FROM iot_events e")) {
        return {
          rows: state.deliveries.has(state.event.event_id)
            ? []
            : [{ event_id: state.event.event_id }],
          rowCount: state.deliveries.has(state.event.event_id) ? 0 : 1,
        };
      }
      return client.query(sql, params);
    },
    async connect() {
      return { ...client, release() {} };
    },
  };

  const warnings = [];
  const logger = {
    warn: (...args) => warnings.push(args),
  };
  const consumer = new AnomalyDetectionConsumer({ pool, logger });

  return { consumer, state, warnings };
}

test("xử lý telemetry hợp lệ và lưu baseline, kết quả, delivery", async () => {
  const { consumer, state } = fixture();

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 1, skipped: 0, failed: 0 });
  assert.equal(state.deliveries.has("event-001"), true);
  assert.equal(state.results.has("1001"), true);
  assert.equal(state.baselines.get("10:temperatureC").length, 1);
});

test("bỏ qua telemetry không eligible", async () => {
  const { consumer, state } = fixture({
    event: {
      event_id: "event-002",
      data_id: "1002",
      payload: {
        eligible: false,
        is_latest: true,
        is_backfill: false,
        clock_skew: false,
      },
    },
  });

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(state.deliveries.has("event-002"), true);
  assert.equal(state.results.size, 0);
});

test("bỏ qua dữ liệu backfill hoặc clock skew", async () => {
  const { consumer, state } = fixture({
    event: {
      event_id: "event-003",
      data_id: "1003",
      payload: {
        eligible: true,
        is_latest: true,
        is_backfill: true,
        clock_skew: false,
      },
    },
    sample: {
      data_id: "1003",
      device_id: "10",
      room_id: "20",
      recorded_at: new Date("2026-11-04T10:00:00.000Z"),
      temperature: 25,
      humidity: 60,
      lux: 300,
      is_backfill: true,
      clock_skew: false,
    },
  });

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(state.results.size, 0);
});

test("bỏ qua thiết bị hoặc phòng học không hoạt động", async () => {
  const { consumer, state } = fixture({
    room: { status: "INACTIVE" },
  });

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(state.deliveries.has("event-001"), true);
  assert.equal(state.results.size, 0);
});

test("rollback và không đánh dấu delivery khi lưu kết quả thất bại", async () => {
  const { consumer, state, warnings } = fixture({
    failResultInsert: true,
  });

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 0, failed: 1 });
  assert.equal(state.deliveries.has("event-001"), false);
  assert.equal(state.results.size, 0);
  assert.equal(state.baselines.size, 0);
  assert.equal(warnings.length, 1);
});

test("không xử lý lại sự kiện đã được đánh dấu delivery", async () => {
  const { consumer, state } = fixture();
  state.deliveries.add("event-001");

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 0, failed: 0 });
  assert.equal(state.results.size, 0);
});

test("bỏ qua telemetry không còn là bản ghi mới nhất", async () => {
  const { consumer, state } = fixture({
    latestDataId: "1002",
  });

  const result = await consumer.consumePending();

  assert.deepEqual(result, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(state.results.size, 0);
  assert.equal(state.deliveries.has("event-001"), true);
});
