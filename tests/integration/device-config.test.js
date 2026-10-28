import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { DeviceConfigService } from "../../backend/src/modules/device-config/device-config.service.js";

async function fixture(t) {
  const f = await iotFixture(t);
  const node = await f.activateSensor();
  const received = [];
  node.client.on("message", (topic, raw) => { if (topic === `${node.topic}/config`) received.push(JSON.parse(raw.toString())); });
  await node.client.subscribeAsync(`${node.topic}/config`, { qos: 1 });
  const create = (settings, token = f.token) => f.request(`/devices/${node.device.device_id}/configs`, { method: "POST", token, body: { settings } });
  const state = async () => (await f.pool.query("SELECT * FROM device_settings WHERE device_id=$1", [node.device.device_id])).rows[0];
  const config = async (id) => (await f.pool.query("SELECT * FROM device_configs WHERE config_id=$1", [id])).rows[0];
  const ackValue = (value, extra = {}) => ({ config_id: value.config_id, device_id: node.device.device_code, room_id: f.room.room_code, session_id: "boot-1", version: value.version, status: "SUCCESS", timestamp: Date.now(), applied_settings: value.settings, ...extra });
  const ack = (value, extra = {}) => node.client.publishAsync(`${node.topic}/config/ack`, JSON.stringify(ackValue(value, extra)), { qos: 1 });
  return { ...f, ...node, received, create, state, config, ackValue, ack };
}

test("remote config uses MQTT ACK to distinguish desired and actually applied settings", async (t) => {
  const f = await fixture(t);
  const response = await f.create({ sample_interval_seconds: 3, heartbeat_interval_seconds: 5 });
  assert.equal(response.status, 202);
  const config = response.body.data;
  assert.equal(config.status, "PENDING");
  assert.equal((await f.state()).applied_version, 0);
  assert.equal((await f.state()).desired_settings.sample_interval_seconds, 3);
  await waitFor(() => f.received.length === 1);
  assert.equal(f.received[0].config_id, config.config_id);
  assert.equal(f.received[0].session_id, "boot-1");
  await f.ack(config);
  await waitFor(async () => (await f.config(config.config_id)).status === "SUCCESS");
  assert.equal((await f.state()).applied_version, 1);
  assert.equal((await f.state()).applied_settings.sample_interval_seconds, 3);
  await f.ack(config);
  const history = await f.request(`/devices/${f.device.device_id}/configs`, { token: f.token });
  assert.equal(history.body.meta.total, 1);
  assert.equal(history.body.data.history[0].requested_token_version, undefined);
  assert.equal((await f.pool.query("SELECT * FROM audit_logs WHERE action='CONFIG_RESULT' AND target_id=$1", [config.config_id])).rowCount, 1);
});

test("config validation enforces heartbeat safety, node capability and Admin-only writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.create({ sample_interval_seconds: 0 })).status, 400);
  assert.equal((await f.create({ heartbeat_interval_seconds: 20 })).status, 400);
  assert.equal((await f.create({ arbitrary: "value" })).status, 400);
  const control = await f.register("CONTROL_NODE");
  // Validate capability on a live Control Node, not merely on an unready device.
  const key = (await f.action(control.device_id, "provision")).body.data.credentials;
  const client = await f.connect(key);
  await client.publishAsync(`smartclassroom/room/${f.room.room_code}/device/${control.device_code}/heartbeat`, JSON.stringify({ msg_id: "control-hb", device_id: control.device_code, room_id: f.room.room_code, session_id: "control-1", timestamp: Date.now(), uptime_seconds: 1, free_heap_bytes: 100000, wifi_rssi_dbm: -50 }), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [control.device_id])).rows[0].connection_status === "ONLINE");
  assert.equal((await f.request(`/devices/${control.device_id}/configs`, { method: "POST", token: f.token, body: { settings: { sample_interval_seconds: 3 } } })).status, 400);
  const password = "config-role-test-password";
  const viewer = (await f.request("/users", { method: "POST", token: f.token, body: { username: "config_viewer", display_name: "Viewer", role: "VIEWER", password } })).body.data;
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: [viewer.user_id] } });
  const token = (await f.request("/auth/login", { method: "POST", body: { username: "config_viewer", password } })).body.data.access_token;
  assert.equal((await f.create({ sample_interval_seconds: 3 }, token)).status, 403);
  assert.equal((await f.request(`/devices/${f.device.device_id}/configs`, { token })).status, 200);
});

test("out-of-order and late config ACKs cannot roll applied version backward", async (t) => {
  const f = await fixture(t);
  const first = (await f.create({ sample_interval_seconds: 3 })).body.data;
  const second = (await f.create({ sample_interval_seconds: 4 })).body.data;
  await f.ack(second);
  await waitFor(async () => (await f.config(second.config_id)).status === "SUCCESS");
  await f.ack(first);
  await waitFor(async () => (await f.config(first.config_id)).status === "SUCCESS");
  assert.equal((await f.state()).applied_version, 2);
  assert.equal((await f.state()).applied_settings.sample_interval_seconds, 4);
  const late = (await f.create({ sample_interval_seconds: 6 })).body.data;
  await f.pool.query("UPDATE device_configs SET timeout_at=now()-interval '1 second' WHERE config_id=$1", [late.config_id]);
  const restarted = new DeviceConfigService({ pool: f.pool, mqtt: f.runtime });
  assert.equal(await restarted.expirePending(), 1);
  assert.equal(await restarted.expirePending(), 0);
  await f.ack(late);
  await waitFor(async () => (await f.config(late.config_id)).late_ack_at !== null);
  assert.equal((await f.config(late.config_id)).status, "TIMEOUT");
  assert.equal((await f.state()).applied_version, 3);
  const failed = (await f.create({ sample_interval_seconds: 7 })).body.data;
  await f.ack(failed, { status: "FAILED", error_code: "APPLY_ERROR" });
  await waitFor(async () => (await f.config(failed.config_id)).status === "FAILED");
  assert.equal((await f.state()).applied_version, 3);
  assert.equal((await f.state()).last_error_code, "APPLY_ERROR");
});

test("restart recovers config committed before publish; audit failure leaves no partial config", async (t) => {
  const f = await fixture(t);
  f.configs.publishOne = async () => { throw new Error("Crash after commit"); };
  assert.equal((await f.create({ sample_interval_seconds: 3 })).status, 500);
  const queued = (await f.pool.query("SELECT * FROM device_configs")).rows[0];
  assert.equal(queued.status, "PENDING");
  assert.equal(queued.published_at, null);
  assert.equal(f.received.length, 0);
  const restarted = new DeviceConfigService({ pool: f.pool, mqtt: f.runtime });
  assert.equal(await restarted.processPending(), 1);
  await waitFor(() => f.received.length === 1);
  assert.equal(f.received[0].config_id, queued.config_id);
  await f.ack(queued);
  await waitFor(async () => (await f.config(queued.config_id)).status === "SUCCESS");
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_config CHECK(action <> 'CONFIG_CREATE') NOT VALID");
  assert.equal((await f.create({ sample_interval_seconds: 4 })).status, 500);
  assert.equal((await f.state()).desired_version, 1);
  assert.equal((await f.pool.query("SELECT * FROM device_configs")).rowCount, 1);
});

test("revocation cancels pending config and rejects stale device ACK", async (t) => {
  const f = await fixture(t);
  const config = (await f.create({ sample_interval_seconds: 3 })).body.data;
  assert.equal((await f.action(f.device.device_id, "revoke", { confirmed: true })).status, 200);
  assert.equal((await f.config(config.config_id)).status, "FAILED");
  await assert.rejects(() => f.configs.handle({ kind: "config/ack", deviceCode: f.device.device_code, roomCode: f.room.room_code, payload: f.ackValue(config) }), (e) => e.code === "CONFIG_ACK_MISMATCH");
  assert.equal((await f.state()).applied_version, 0);
});
