import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { TelemetryPipeline, bindTelemetry } from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";
import { AlertsService } from "../../backend/src/modules/alerts/alerts.service.js";

async function fixture(t) {
  const f = await iotFixture(t);
  const pipeline = new TelemetryPipeline({ pool: f.pool, mqtt: f.runtime, logger: f.logger });
  t.after(bindTelemetry(f.runtime, pipeline));
  const node = await f.activateSensor();
  let sequence = 0;
  const sample = async (temperature, humidity = 65, { consume = true, timestamp = Date.now() } = {}) => {
    const value = { msg_id: `ALERT_${++sequence}`, device_id: node.device.device_code, room_id: f.room.room_code, timestamp, data: { temperature, humidity, lux: 300, occupancy: true } };
    await node.client.publishAsync(`${node.topic}/telemetry`, JSON.stringify(value), { qos: 1 });
    await waitFor(async () => (await f.pool.query("SELECT data_id FROM sensor_data WHERE msg_id=$1", [value.msg_id])).rowCount === 1);
    if (consume) await f.alerts.consumeTelemetry();
    return value;
  };
  const open = async (type = "TEMP_HIGH") => (await f.pool.query("SELECT * FROM alerts WHERE alert_type=$1 AND status<>'RESOLVED' ORDER BY alert_id", [type])).rows;
  return { ...f, ...node, pipeline, sample, open };
}

test("temperature warnings escalate, recover after three clear samples and downgrade without duplicate open alerts", async (t) => {
  const f = await fixture(t);
  await f.sample(32);
  const first = (await f.open())[0];
  assert.equal(first.severity, "WARNING");
  await f.sample(36);
  assert.equal((await f.open())[0].alert_id, first.alert_id);
  assert.equal((await f.open())[0].severity, "CRITICAL");
  await f.sample(32);
  await f.sample(32);
  assert.equal((await f.open())[0].severity, "CRITICAL");
  await f.sample(32);
  const warning = (await f.open())[0];
  assert.equal(warning.severity, "WARNING");
  assert.notEqual(warning.alert_id, first.alert_id);
  for (let i = 0; i < 3; i++) await f.sample(27);
  assert.equal((await f.open()).length, 0);
  assert.ok((await f.pool.query("SELECT resolved_reason FROM alerts WHERE alert_type='TEMP_HIGH'")).rows.every((a) => a.resolved_reason === "AUTO_RECOVERED"));
});

test("durable alert consumers are idempotent across concurrent processing, replay and restart", async (t) => {
  const f = await fixture(t);
  const value = await f.sample(36, 65, { consume: false });
  const counts = await Promise.all([f.alerts.consumeTelemetry(), f.alerts.consumeTelemetry()]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
  assert.equal((await f.open()).length, 1);
  assert.equal((await f.open())[0].occurrence_count, 1);
  await f.client.publishAsync(`${f.topic}/telemetry`, JSON.stringify(value), { qos: 1 });
  const restarted = new AlertsService({ pool: f.pool });
  assert.equal(await restarted.consumeTelemetry(), 0);
  assert.equal((await f.open())[0].occurrence_count, 1);
  await f.sample(40, 95, { timestamp: Date.now() - 600000 });
  assert.equal((await f.open())[0].occurrence_count, 1);
  assert.equal((await f.open("HUMIDITY_HIGH")).length, 0);
});

test("room thresholds override defaults, validate severity order and roll back invalid batches", async (t) => {
  const f = await fixture(t);
  const path = `/rooms/${f.room.room_id}/alert-thresholds`;
  const original = await f.request(path, { token: f.token });
  assert.equal(original.body.data.length, 4);
  const make = (severity, threshold_value, clear_value) => ({ sensor_type: "TEMPERATURE", severity, operator: "GTE", threshold_value, clear_value, is_enabled: true });
  const invalid = await f.request(path, { method: "PUT", token: f.token, body: { thresholds: [make("WARNING", 40, 38)] } });
  assert.equal(invalid.status, 400);
  assert.equal((await f.request(path, { token: f.token })).body.data.find((r) => r.sensor_type === "TEMPERATURE" && r.severity === "WARNING").threshold_value, 30);
  assert.equal((await f.request(path, { method: "PUT", token: f.token, body: { thresholds: [make("WARNING", 20, 21)] } })).status, 400);
  assert.equal((await f.request(path, { method: "PUT", token: f.token, body: { thresholds: [make("WARNING", 20, 18), make("CRITICAL", 25, 23)] } })).status, 200);
  await f.sample(26);
  assert.equal((await f.open())[0].severity, "CRITICAL");
  assert.equal((await f.pool.query("SELECT threshold_value FROM alert_thresholds WHERE room_id IS NULL AND sensor_type='TEMPERATURE' AND severity='WARNING'")).rows[0].threshold_value, 30);
});

test("Viewer can only read alerts; Operator actions require room scope and are audited once", async (t) => {
  const f = await fixture(t);
  await f.sample(36);
  const alert = (await f.open())[0];
  const password = "alert-role-test-password";
  const members = [];
  for (const role of ["VIEWER", "OPERATOR"]) members.push((await f.request("/users", { method: "POST", token: f.token, body: { username: `alert_${role}`, password, display_name: role, role } })).body.data);
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: members.map((m) => m.user_id) } });
  const login = async (role) => (await f.request("/auth/login", { method: "POST", body: { username: `alert_${role}`, password } })).body.data.access_token;
  const viewer = await login("VIEWER"), operator = await login("OPERATOR");
  assert.equal((await f.request("/alerts", { token: viewer })).body.meta.total, 1);
  assert.equal((await f.request(`/alerts/${alert.alert_id}/acknowledge`, { method: "POST", token: viewer })).status, 403);
  const acknowledge = () => f.request(`/alerts/${alert.alert_id}/acknowledge`, { method: "POST", token: operator });
  assert.equal((await acknowledge()).body.data.status, "ACKNOWLEDGED");
  assert.equal((await acknowledge()).status, 200);
  assert.equal((await f.pool.query("SELECT * FROM audit_logs WHERE action='ALERT_ACKNOWLEDGE'")).rowCount, 1);
  assert.equal((await f.request(`/alerts/${alert.alert_id}/resolve`, { method: "POST", token: operator, body: { reason: "Đã kiểm tra" } })).body.data.status, "RESOLVED");
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: [members[0].user_id] } });
  const outside = await login("OPERATOR");
  assert.equal((await f.request("/alerts", { token: outside })).body.meta.total, 0);
  assert.equal((await f.request(`/alerts/${alert.alert_id}/acknowledge`, { method: "POST", token: outside })).status, 404);
});

test("offline/fault alerts deduplicate, recover and resolve when a device is revoked", async (t) => {
  const f = await fixture(t);
  await f.pool.query("UPDATE devices SET last_seen=now()-interval '31 seconds' WHERE device_id=$1", [f.device.device_id]);
  await f.presence.scanOffline();
  await Promise.all([f.alerts.scanDevices(), f.alerts.scanDevices()]);
  assert.equal((await f.open("DEVICE_OFFLINE")).length, 1);
  assert.equal((await f.open("DEVICE_OFFLINE"))[0].occurrence_count, 1);
  await f.client.publishAsync(`${f.topic}/heartbeat`, JSON.stringify({ msg_id: "recover-hb", device_id: f.device.device_code, room_id: f.room.room_code, session_id: "boot-1", timestamp: Date.now(), uptime_seconds: 20, free_heap_bytes: 100000, wifi_rssi_dbm: -55 }), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [f.device.device_id])).rows[0].connection_status === "ONLINE");
  await f.alerts.scanDevices();
  assert.equal((await f.open("DEVICE_OFFLINE")).length, 0);
  for (let i = 0; i < 5; i++) await f.client.publishAsync(`${f.topic}/telemetry`, JSON.stringify({ msg_id: `BAD_${i}`, device_id: f.device.device_code, room_id: f.room.room_code, timestamp: Date.now(), data: { temperature: 99, humidity: 60, lux: 300, occupancy: true } }), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT lifecycle_status FROM devices WHERE device_id=$1", [f.device.device_id])).rows[0].lifecycle_status === "FAULT");
  await f.alerts.scanDevices();
  assert.equal((await f.open("DEVICE_FAULT"))[0].severity, "CRITICAL");
  await f.action(f.device.device_id, "clear-fault");
  await f.alerts.scanDevices();
  assert.equal((await f.open("DEVICE_FAULT")).length, 0);
  await f.sample(36);
  await f.action(f.device.device_id, "revoke", { confirmed: true });
  await f.alerts.scanDevices();
  assert.equal((await f.open()).length, 0);
  assert.equal((await f.pool.query("SELECT resolved_reason FROM alerts WHERE alert_type='TEMP_HIGH' ORDER BY alert_id DESC LIMIT 1")).rows[0].resolved_reason, "DEVICE_REVOKED");
});

test("alert audit failure rolls back alert and delivery marker so recovery can replay the event", async (t) => {
  const f = await fixture(t);
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_alert CHECK(action <> 'ALERT_CREATE') NOT VALID");
  await assert.rejects(() => f.sample(36), (e) => e.code === "23514");
  assert.equal((await f.open()).length, 0);
  assert.equal((await f.pool.query("SELECT * FROM iot_event_deliveries WHERE consumer='alerts'")).rowCount, 0);
  await f.owner.query("ALTER TABLE audit_logs DROP CONSTRAINT test_fail_alert");
  assert.equal(await f.alerts.consumeTelemetry(), 1);
  assert.equal((await f.open()).length, 1);
});
