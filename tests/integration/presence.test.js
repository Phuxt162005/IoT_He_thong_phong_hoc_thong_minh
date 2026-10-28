import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { DevicePresenceService } from "../../backend/src/modules/device-presence/device-presence.service.js";

const hb = (f, device, changes = {}) => ({ msg_id: "hb-next", device_id: device.device_code, room_id: f.room.room_code, session_id: "boot-1", timestamp: Date.now(), uptime_seconds: 20, free_heap_bytes: 150000, wifi_rssi_dbm: -55, ...changes });
const envelope = (f, device, kind, payload) => ({ kind, deviceCode: device.device_code, roomCode: f.room.room_code, topic: `smartclassroom/room/${f.room.room_code}/device/${device.device_code}/${kind}`, payload });

test("heartbeat updates diagnostics but duplicates and older uptime cannot refresh last_seen", async (t) => {
  const f = await iotFixture(t);
  const { device, client, topic } = await f.activateSensor();
  const value = hb(f, device);
  await client.publishAsync(`${topic}/heartbeat`, JSON.stringify(value), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT last_uptime_seconds FROM devices WHERE device_id=$1", [device.device_id])).rows[0].last_uptime_seconds === "20");
  const before = (await f.pool.query("SELECT * FROM devices WHERE device_id=$1", [device.device_id])).rows[0];
  assert.equal(before.last_rssi_dbm, -55);
  assert.equal(before.last_free_heap_bytes, "150000");
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", value)), false);
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { msg_id: "old", uptime_seconds: 15 }))), false);
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { session_id: "unknown-old-session", timestamp: value.timestamp - 1, uptime_seconds: 999 }))), false);
  const after = (await f.pool.query("SELECT * FROM devices WHERE device_id=$1", [device.device_id])).rows[0];
  assert.equal(after.last_seen.getTime(), before.last_seen.getTime());
  assert.equal(after.lifecycle_status, "ACTIVE");
});

test("offline scanning is idempotent across restart and a fresh heartbeat restores only connectivity", async (t) => {
  const f = await iotFixture(t);
  const { device } = await f.activateSensor();
  await f.pool.query("UPDATE devices SET last_seen=now()-interval '31 seconds' WHERE device_id=$1", [device.device_id]);
  assert.equal(await f.presence.scanOffline(), 1);
  assert.equal(await f.presence.scanOffline(), 0);
  const restarted = new DevicePresenceService({ pool: f.pool });
  assert.equal(await restarted.scanOffline(), 0);
  const offline = (await f.pool.query("SELECT * FROM devices WHERE device_id=$1", [device.device_id])).rows[0];
  assert.equal(offline.connection_status, "OFFLINE");
  assert.equal(offline.lifecycle_status, "ACTIVE");
  assert.equal((await f.pool.query("SELECT * FROM iot_events WHERE event_type='device.status_changed' AND payload->>'status'='OFFLINE'")).rowCount, 1);
  assert.equal(await restarted.handle(envelope(f, device, "heartbeat", hb(f, device))), true);
  assert.equal((await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status, "ONLINE");
});

test("real LWT marks offline; reconnect with a new session ignores old LWT and heartbeat", async (t) => {
  const f = await iotFixture(t);
  const device = await f.register();
  const key = (await f.action(device.device_id, "provision")).body.data.credentials;
  const topic = `smartclassroom/room/${f.room.room_code}/device/${device.device_code}`;
  const status = (session_id, state) => ({ device_id: device.device_code, room_id: f.room.room_code, session_id, status: state });
  const first = await f.connect(key, { will: { topic: `${topic}/status`, payload: JSON.stringify(status("connection-1", "OFFLINE")), qos: 1, retain: false } });
  await first.publishAsync(`${topic}/heartbeat`, JSON.stringify(hb(f, device, { session_id: "connection-1" })), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status === "ONLINE");
  assert.equal((await f.action(device.device_id, "activate")).status, 200);
  first.stream.destroy();
  await waitFor(async () => (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status === "OFFLINE");
  const second = await f.connect(key);
  await second.publishAsync(`${topic}/heartbeat`, JSON.stringify(hb(f, device, { session_id: "connection-2", uptime_seconds: 30 })), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT session_id FROM devices WHERE device_id=$1", [device.device_id])).rows[0].session_id === "connection-2");
  assert.equal(await f.presence.handle(envelope(f, device, "status", status("connection-1", "OFFLINE"))), false);
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { session_id: "connection-1", uptime_seconds: 999 }))), false);
  assert.equal((await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status, "ONLINE");
  assert.equal((await f.pool.query("SELECT * FROM device_sessions WHERE device_id=$1 AND closed_at IS NULL", [device.device_id])).rowCount, 1);
});

test("ONLINE status alone does not activate; first current-session heartbeat is required", async (t) => {
  const f = await iotFixture(t);
  const device = await f.register();
  await f.action(device.device_id, "provision");
  const status = { device_id: device.device_code, room_id: f.room.room_code, session_id: "connection-new", timestamp: Date.now(), status: "ONLINE" };
  assert.equal(await f.presence.handle(envelope(f, device, "status", status)), true);
  assert.equal((await f.action(device.device_id, "activate")).status, 409);
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { session_id: "connection-new" }))), true);
  assert.equal((await f.action(device.device_id, "activate")).status, 200);
});

test("invalid or stale heartbeat cannot change presence and audit failure rolls back session creation", async (t) => {
  const f = await iotFixture(t);
  const device = await f.register();
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device))), false);
  await f.action(device.device_id, "provision");
  assert.equal(await f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { timestamp: Date.now() - 60000 }))), false);
  await assert.rejects(() => f.presence.handle(envelope(f, device, "heartbeat", hb(f, device, { device_id: "WRONG" }))), (e) => e.code === "INVALID_HEARTBEAT");
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_connection CHECK(action <> 'DEVICE_CONNECTION_CHANGE') NOT VALID");
  await assert.rejects(() => f.presence.handle(envelope(f, device, "heartbeat", hb(f, device))), (e) => e.code === "23514");
  const current = (await f.pool.query("SELECT * FROM devices WHERE device_id=$1", [device.device_id])).rows[0];
  assert.equal(current.connection_status, "UNKNOWN");
  assert.equal(current.last_seen, null);
  assert.equal((await f.pool.query("SELECT * FROM device_sessions WHERE device_id=$1", [device.device_id])).rowCount, 0);
});
