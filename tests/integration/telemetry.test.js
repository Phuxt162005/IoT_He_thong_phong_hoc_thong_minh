import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { TelemetryPipeline, bindTelemetry } from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";

async function fixture(t) {
  const f = await iotFixture(t);
  const pipeline = new TelemetryPipeline({ pool: f.pool, mqtt: f.runtime, logger: f.logger });
  const unbind = bindTelemetry(f.runtime, pipeline);
  t.after(unbind);
  const events = [];
  pipeline.events.on("telemetry.stored", (event) => events.push(event));
  const sensor = await f.activateSensor();
  const acks = [];
  sensor.client.on("message", (topic, raw) => { if (topic === `${sensor.topic}/telemetry/ack`) acks.push(JSON.parse(raw.toString())); });
  await sensor.client.subscribeAsync(`${sensor.topic}/telemetry/ack`, { qos: 1 });
  const payload = (msg_id, changes = {}) => ({ msg_id, device_id: sensor.device.device_code, room_id: f.room.room_code, timestamp: Date.now(), data: { temperature: 27.5, humidity: 65, lux: 320, occupancy: true }, ...changes });
  const publish = (value) => sensor.client.publishAsync(`${sensor.topic}/telemetry`, JSON.stringify(value), { qos: 1 });
  const envelope = (value) => ({ topic: `${sensor.topic}/telemetry`, kind: "telemetry", deviceCode: sensor.device.device_code, roomCode: f.room.room_code, payload: value });
  return { ...f, ...sensor, pipeline, events, acks, payload, publish, envelope };
}

test("MQTT telemetry is committed before ACK and concurrent retries store exactly one record/event", async (t) => {
  const f = await fixture(t);
  const value = f.payload("SAME_EVENT");
  await Promise.all(Array.from({ length: 6 }, () => f.publish(value)));
  await waitFor(() => f.acks.length === 6);
  assert.equal((await f.pool.query("SELECT * FROM sensor_data")).rowCount, 1);
  assert.equal((await f.pool.query("SELECT * FROM iot_events WHERE event_type='telemetry.stored'")).rowCount, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].eligible, true);
  assert.equal(f.acks.filter((a) => !a.duplicate).length, 1);
  assert.ok(f.acks.every((a) => a.msg_id === "SAME_EVENT" && a.status === "STORED"));
  await f.publish({ ...value, data: { ...value.data, temperature: 28 } });
  await waitFor(() => f.mqttSink.getEntries().some((e) => e.metadata.code === "EVENT_ID_CONFLICT"));
  assert.equal(f.acks.length, 6);
  assert.equal((await f.pool.query("SELECT temperature FROM sensor_data")).rows[0].temperature, 27.5);
});

test("database write failure produces no ACK; retry after recovery succeeds without partial data", async (t) => {
  const f = await fixture(t);
  await f.owner.query("ALTER TABLE sensor_data ADD CONSTRAINT test_reject_temperature CHECK(temperature<30) NOT VALID");
  const value = f.payload("RETRY_AFTER_DB_RECOVERY", { data: { temperature: 31, humidity: 50, lux: 300, occupancy: true } });
  await f.publish(value);
  await waitFor(() => f.mqttSink.getEntries().some((e) => e.metadata.code === "23514"));
  assert.equal(f.acks.length, 0);
  assert.equal((await f.pool.query("SELECT * FROM sensor_data")).rowCount, 0);
  assert.equal((await f.pool.query("SELECT * FROM iot_events WHERE event_type='telemetry.stored'")).rowCount, 0);
  await f.owner.query("ALTER TABLE sensor_data DROP CONSTRAINT test_reject_temperature");
  await f.publish(value);
  await waitFor(() => f.acks.length === 1);
  assert.equal(f.acks[0].status, "STORED");
  assert.equal(f.acks[0].duplicate, false);
});

test("offline backfill preserves measured time without overwriting latest or becoming eligible", async (t) => {
  const f = await fixture(t);
  const current = f.payload("CURRENT");
  await f.publish(current);
  await waitFor(() => f.acks.length === 1);
  const old = f.payload("BACKFILL", { timestamp: current.timestamp - 10 * 60 * 1000, data: { temperature: 22, humidity: 60, lux: 200, occupancy: false } });
  await f.publish(old);
  await waitFor(() => f.acks.length === 2);
  const history = (await f.pool.query("SELECT * FROM sensor_data WHERE msg_id='BACKFILL'")).rows[0];
  assert.equal(history.recorded_at.getTime(), old.timestamp);
  assert.equal(history.is_backfill, true);
  const latest = (await f.pool.query("SELECT d.* FROM telemetry_latest l JOIN sensor_data d ON d.data_id=l.data_id")).rows[0];
  assert.equal(latest.msg_id, "CURRENT");
  assert.equal(f.events.find((e) => e.telemetry.msg_id === "BACKFILL").eligible, false);
});

test("legacy payloads keep fractional lux and null occupancy; unknown/future clocks only enter history", async (t) => {
  const f = await fixture(t);
  const value = { messageType: "telemetry", eventId: "LEGACY_1", deviceId: f.device.device_code, roomCode: f.room.room_code, timestamp: new Date().toISOString(), temperatureC: 27.5, humidityPercent: 65, illuminanceLux: 321.5 };
  await f.publish(value);
  await waitFor(() => f.acks.length === 1);
  assert.equal(f.acks[0].eventId, "LEGACY_1");
  assert.equal(f.acks[0].messageType, "telemetry_ack");
  const legacy = (await f.pool.query("SELECT * FROM sensor_data WHERE msg_id='LEGACY_1'")).rows[0];
  assert.equal(legacy.occupancy, null);
  assert.equal(legacy.lux, 321.5);
  await f.publish({ ...value, eventId: "NO_CLOCK", timestamp: "" });
  await f.publish(f.payload("FUTURE_CLOCK", { timestamp: Date.now() + 60 * 60 * 1000 }));
  await waitFor(() => f.acks.length === 3);
  assert.ok((await f.pool.query("SELECT clock_skew FROM sensor_data WHERE msg_id IN ('NO_CLOCK','FUTURE_CLOCK')")).rows.every((row) => row.clock_skew));
  assert.equal((await f.pool.query("SELECT d.msg_id FROM telemetry_latest l JOIN sensor_data d ON d.data_id=l.data_id")).rows[0].msg_id, "LEGACY_1");
  assert.ok(f.events.filter((e) => e.clock_skew).every((e) => !e.eligible));
});

test("payload/topic mismatch is rejected; five invalid measurements enter FAULT and valid samples remain observable", async (t) => {
  const f = await fixture(t);
  await f.publish(f.payload("WRONG_ID", { device_id: "OTHER_DEVICE" }));
  await waitFor(() => f.mqttSink.getEntries().some((e) => e.metadata.code === "TOPIC_PAYLOAD_MISMATCH"));
  assert.equal(f.acks.length, 0);
  for (let i = 0; i < 5; i++) await f.publish(f.payload(`INVALID_${i}`, { data: { temperature: 99, humidity: 60, lux: 100, occupancy: true } }));
  await waitFor(async () => (await f.pool.query("SELECT lifecycle_status FROM devices WHERE device_id=$1", [f.device.device_id])).rows[0].lifecycle_status === "FAULT");
  assert.equal((await f.pool.query("SELECT * FROM sensor_data")).rowCount, 0);
  await f.publish(f.payload("VALID_IN_FAULT"));
  await waitFor(() => f.acks.length === 1);
  assert.equal(f.events[0].eligible, false);
  assert.equal((await f.pool.query("SELECT fault_counters FROM devices WHERE device_id=$1", [f.device.device_id])).rows[0].fault_counters.sensor_err, 0);
});

test("revoked devices cannot ingest queued telemetry and another device may use the same msg_id", async (t) => {
  const f = await fixture(t);
  const value = f.payload("PER_DEVICE_EVENT");
  await f.publish(value);
  await waitFor(() => f.acks.length === 1);
  assert.equal((await f.action(f.device.device_id, "revoke", { confirmed: true })).status, 200);
  await assert.rejects(() => f.pipeline.ingest(f.envelope({ ...value, msg_id: "QUEUED_AFTER_REVOKE" })), (e) => e.code === "DEVICE_NOT_ACCEPTING_TELEMETRY");
  const next = await f.activateSensor();
  await f.pipeline.ingest({ topic: `${next.topic}/telemetry`, kind: "telemetry", deviceCode: next.device.device_code, roomCode: f.room.room_code, payload: { ...value, device_id: next.device.device_code } });
  assert.equal((await f.pool.query("SELECT * FROM sensor_data WHERE msg_id='PER_DEVICE_EVENT'")).rowCount, 2);
  assert.equal((await f.pool.query("SELECT * FROM sensor_data WHERE msg_id='QUEUED_AFTER_REVOKE'")).rowCount, 0);
});
