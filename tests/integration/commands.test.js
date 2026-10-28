import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { CommandsService } from "../../backend/src/modules/commands/commands.service.js";
import { withTransaction } from "../../backend/src/database/pool.js";

async function fixture(t) {
  const f = await iotFixture(t);
  const node = await f.activateControl();
  const { device, client, topic } = node;
  const received = [];
  client.on("message", (name, raw) => { if (name === `${topic}/command`) received.push(JSON.parse(raw.toString())); });
  await client.subscribeAsync(`${topic}/command`, { qos: 1 });
  await client.publishAsync(`${topic}/reported`, JSON.stringify({ device_id: device.device_code, room_id: f.room.room_code, session_id: "boot-1", shadow_version: 0, reported_state: { light: "OFF", fan: "OFF" }, timestamp: Date.now() }), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT reported_state FROM device_shadows WHERE device_id=$1", [device.device_id])).rows[0].reported_state.fan === "OFF");
  const create = (desired_state, { key, token = f.token, timeout_seconds } = {}) => f.request(`/devices/${device.device_id}/commands`, { method: "POST", token, body: { desired_state, ...(timeout_seconds ? { timeout_seconds } : {}) }, headers: key ? { "Idempotency-Key": key } : {} });
  const shadow = async () => (await f.request(`/devices/${device.device_id}/shadow`, { token: f.token })).body.data;
  const ackValue = (command, extra = {}) => ({ command_id: command.command_id, device_id: device.device_code, room_id: f.room.room_code, session_id: "boot-1", shadow_version: command.shadow_version, status: "SUCCESS", reported_state: command.desired_state, timestamp: Date.now(), ...extra });
  const ack = (command, extra = {}) => client.publishAsync(`${topic}/ack`, JSON.stringify(ackValue(command, extra)), { qos: 1 });
  const command = async (id) => (await f.pool.query("SELECT * FROM commands WHERE command_id=$1", [id])).rows[0];
  const queueWithoutPublish = async (state) => withTransaction(f.pool, async (connection) => {
    const actor = (await connection.query("SELECT u.*, 'ADMIN' AS role FROM users u WHERE username='test_admin'")).rows[0];
    const current = (await connection.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [device.device_id])).rows[0];
    return f.commands.enqueue(connection, current, state, { actor });
  });
  return { ...f, ...node, received, create, shadow, ackValue, ack, command, queueWithoutPublish };
}

test("real MQTT command keeps reported state until ACK, then synchronizes shadow and history", async (t) => {
  const f = await fixture(t);
  const response = await f.create({ fan: "ON" });
  assert.equal(response.status, 202);
  const command = response.body.data.command;
  assert.equal(command.status, "PENDING");
  assert.equal(response.body.data.shadow.desired_state.fan, "ON");
  assert.equal(response.body.data.shadow.reported_state.fan, "OFF");
  await waitFor(() => f.received.length === 1);
  assert.equal(f.received[0].command_id, command.command_id);
  assert.equal(f.received[0].session_id, "boot-1");
  assert.ok(f.received[0].expires_at > f.received[0].timestamp);
  await f.ack(command);
  await waitFor(async () => (await f.command(command.command_id)).status === "SUCCESS");
  assert.equal((await f.shadow()).in_sync, true);
  await f.ack(command);
  await waitFor(async () => (await f.pool.query("SELECT * FROM audit_logs WHERE action='COMMAND_RESULT' AND target_id=$1", [command.command_id])).rowCount === 1);
  const list = await f.request(`/devices/${f.device.device_id}/commands`, { token: f.token });
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.data[0].requested_token_version, undefined);
});

test("concurrent idempotency retries send once, reject changed payload and return cache during broker outage", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.create({ fan: "ON" }, { key: "same-key" })));
  assert.ok(results.every((r) => [200, 202].includes(r.status)));
  assert.equal(new Set(results.map((r) => r.body.data.command.command_id)).size, 1);
  assert.equal(results.filter((r) => r.status === 202).length, 1);
  await waitFor(() => f.received.length === 1);
  assert.equal((await f.create({ fan: "OFF" }, { key: "same-key" })).status, 409);
  f.runtime.ready = false;
  assert.equal((await f.create({ fan: "ON" }, { key: "same-key" })).status, 200);
  assert.equal((await f.create({ fan: "OFF" })).status, 503);
  f.runtime.ready = true;
  assert.equal((await f.pool.query("SELECT * FROM commands")).rowCount, 1);
});

test("command permissions include room scope and Viewer cannot control", async (t) => {
  const f = await fixture(t);
  const password = "command-role-test-password";
  const members = [];
  for (const role of ["VIEWER", "OPERATOR"]) {
    const user = await f.request("/users", { method: "POST", token: f.token, body: { username: `user_${role}`, password, display_name: role, role } });
    assert.equal(user.status, 201);
    members.push(user.body.data);
  }
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: members.map((u) => u.user_id) } });
  const tokens = {};
  for (const user of members) tokens[user.role] = (await f.request("/auth/login", { method: "POST", body: { username: user.username, password } })).body.data.access_token;
  assert.equal((await f.create({ fan: "ON" }, { token: tokens.VIEWER })).status, 403);
  assert.equal((await f.create({ fan: "ON" }, { token: tokens.OPERATOR })).status, 202);
  const otherRoom = (await f.request("/rooms", { method: "POST", token: f.token, body: { room_code: "ROOM_303", room_name: "Other" } })).body.data;
  const other = (await f.request("/devices", { method: "POST", token: f.token, body: { device_code: "OTHER_CTRL", device_name: "Other", device_type: "CONTROL_NODE", room_id: otherRoom.room_id } })).body.data;
  assert.equal((await f.request(`/devices/${other.device_id}/shadow`, { token: tokens.OPERATOR })).status, 404);
  assert.equal((await f.request(`/devices/${other.device_id}/commands`, { method: "POST", token: tokens.OPERATOR, body: { desired_state: { fan: "ON" } } })).status, 404);
});

test("out-of-order ACKs preserve newer actuator state while independent actuators still synchronize", async (t) => {
  const f = await fixture(t);
  const first = (await f.create({ fan: "ON" })).body.data.command;
  const second = (await f.create({ fan: "OFF" })).body.data.command;
  await f.ack(second);
  await waitFor(async () => (await f.command(second.command_id)).status === "SUCCESS");
  await f.ack(first);
  await waitFor(async () => (await f.command(first.command_id)).status === "SUCCESS");
  assert.equal((await f.shadow()).reported_state.fan, "OFF");
  const light = (await f.create({ light: "ON" })).body.data.command;
  const fan = (await f.create({ fan: "ON" })).body.data.command;
  await f.ack(fan);
  await f.ack(light);
  await waitFor(async () => (await f.command(light.command_id)).status === "SUCCESS");
  assert.deepEqual((await f.shadow()).reported_state, { light: "ON", fan: "ON" });
  assert.equal((await f.shadow()).in_sync, true);
});

test("timeout persists across restart and late ACK cannot overwrite a newer state", async (t) => {
  const f = await fixture(t);
  const old = (await f.create({ fan: "ON" })).body.data.command;
  await f.pool.query("UPDATE commands SET timeout_at=now()-interval '1 second' WHERE command_id=$1", [old.command_id]);
  const restarted = new CommandsService({ pool: f.pool, mqtt: f.runtime, logger: f.logger });
  assert.equal(await restarted.expirePending(), 1);
  assert.equal(await restarted.expirePending(), 0);
  const fresh = (await f.create({ fan: "OFF" })).body.data.command;
  await f.ack(fresh);
  await waitFor(async () => (await f.command(fresh.command_id)).status === "SUCCESS");
  await f.ack(old);
  await waitFor(async () => (await f.command(old.command_id)).late_ack_at !== null);
  assert.equal((await f.command(old.command_id)).status, "TIMEOUT");
  assert.equal((await f.shadow()).reported_state.fan, "OFF");
  assert.equal((await f.shadow()).last_command_error, null);
  const queued = await f.queueWithoutPublish({ light: "ON" });
  assert.equal(queued.published_at, null);
  assert.equal(await restarted.processPending(), 1);
  await waitFor(() => f.received.some((c) => c.command_id === queued.command_id));
  assert.ok((await f.command(queued.command_id)).published_at);
});

test("unpublished command is not sent after the requesting user's session is revoked", async (t) => {
  const f = await fixture(t);
  const queued = await f.queueWithoutPublish({ fan: "ON" });
  await f.request("/auth/logout", { method: "POST", token: f.token });
  assert.equal(await f.commands.processPending(), 1);
  assert.equal((await f.command(queued.command_id)).status, "FAILED");
  assert.equal((await f.command(queued.command_id)).error_code, "PERMISSION_REVOKED");
  assert.equal(f.received.length, 0);
});

test("publish failure and audit failure preserve honest shadow and atomic command data", async (t) => {
  const f = await fixture(t);
  f.commands.mqtt = { ready: true, async publish() { throw new Error("Broker unavailable"); } };
  const failed = await f.create({ fan: "ON" });
  assert.equal(failed.status, 503);
  const id = failed.body.error.details.command_id;
  assert.equal((await f.command(id)).error_code, "PUBLISH_ERROR");
  assert.equal((await f.shadow()).desired_state.fan, "ON");
  assert.equal((await f.shadow()).reported_state.fan, "OFF");
  f.commands.mqtt = f.runtime;
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_command CHECK(action <> 'COMMAND_CREATE') NOT VALID");
  assert.equal((await f.create({ fan: "OFF" })).status, 500);
  assert.equal((await f.pool.query("SELECT * FROM commands")).rowCount, 1);
  assert.equal((await f.shadow()).desired_state.fan, "ON");
  assert.equal(f.received.length, 0);
});

test("maintenance and a new connection cancel pending commands without inventing reported state", async (t) => {
  const f = await fixture(t);
  const pending = (await f.create({ fan: "ON" })).body.data.command;
  assert.equal((await f.action(f.device.device_id, "maintenance")).status, 200);
  assert.equal((await f.command(pending.command_id)).error_code, "DEVICE_MAINTENANCE");
  assert.equal((await f.action(f.device.device_id, "resume")).status, 200);
  const next = (await f.create({ light: "ON" })).body.data.command;
  await f.client.publishAsync(`${f.topic}/status`, JSON.stringify({ device_id: f.device.device_code, room_id: f.room.room_code, session_id: "connection-2", timestamp: Date.now(), status: "ONLINE", shadow_version: 0, reported_state: { light: "OFF", fan: "OFF" } }), { qos: 1 });
  await waitFor(async () => (await f.command(next.command_id)).status === "FAILED");
  assert.equal((await f.command(next.command_id)).error_code, "DEVICE_RECONNECTED");
  await waitFor(async () => (await f.shadow()).reported_state.light === "OFF");
  assert.equal((await f.create({ fan: "ON" })).status, 409);
  await assert.rejects(() => f.commands.handle({ kind: "ack", deviceCode: f.device.device_code, roomCode: f.room.room_code, payload: f.ackValue(next) }), (e) => e.code === "DEVICE_SESSION_MISMATCH");
});

test("invalid ACKs do not complete commands and three FAILED device ACKs raise FAULT", async (t) => {
  const f = await fixture(t);
  const first = (await f.create({ fan: "ON" })).body.data.command;
  await f.ack(first, { command_id: randomUUID() });
  await waitFor(() => f.mqttSink.getEntries().some((e) => e.metadata.code === "ACK_COMMAND_MISMATCH"));
  await f.ack(first, { reported_state: { fan: "OFF" } });
  await waitFor(() => f.mqttSink.getEntries().some((e) => e.metadata.code === "ACK_STATE_MISMATCH"));
  assert.equal((await f.command(first.command_id)).status, "PENDING");
  const failure = { status: "FAILED", reported_state: { fan: "OFF" }, error_code: "RELAY_FAILURE" };
  await f.ack(first, failure);
  await waitFor(async () => (await f.command(first.command_id)).status === "FAILED");
  await f.ack(first, failure);
  for (let i = 0; i < 2; i++) {
    const command = (await f.create({ fan: "ON" })).body.data.command;
    await f.ack(command, failure);
    await waitFor(async () => (await f.command(command.command_id)).status === "FAILED");
  }
  const device = (await f.pool.query("SELECT lifecycle_status,fault_counters FROM devices WHERE device_id=$1", [f.device.device_id])).rows[0];
  assert.equal(device.lifecycle_status, "FAULT");
  assert.equal(device.fault_counters.relay_err, 3);
  assert.equal((await f.create({ fan: "OFF" })).status, 409);
});
