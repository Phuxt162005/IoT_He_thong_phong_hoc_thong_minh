import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";

const password = "device-test-password-only";
async function fixture(t) {
  const db = await testDatabase(t);
  await seed(db.pool, { username: "test_admin", password, demoPassword: password });
  const http = await testHttp(t, db.pool);
  const login = async (username) => (await http.request("/auth/login", { method: "POST", body: { username, password } })).body.data;
  const admin = await login("test_admin");
  const room = (await http.request("/rooms", { method: "POST", token: admin.access_token, body: { room_code: "ROOM_302", room_name: "Phòng 302" } })).body.data;
  const register = (input = {}) => http.request("/devices", { method: "POST", token: admin.access_token, body: { device_code: "CTRL_01", device_name: "Control", device_type: "CONTROL_NODE", room_id: room.room_id, ...input } });
  const action = (id, name, extra = {}) => http.request(`/devices/${id}/${name}`, { method: "POST", token: admin.access_token, body: { reason: "Kiểm tra vòng đời", ...extra } });
  return { ...db, ...http, login, admin, room, register, action };
}

test("registration validates identity, reserves room type and creates UNKNOWN actuators", async (t) => {
  const { register, request, admin, room, pool } = await fixture(t);
  const created = await register({ hardware_version: "rev-1", firmware_version: "v1" });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.lifecycle_status, "REGISTERED");
  assert.equal(created.body.data.connection_status, "UNKNOWN");
  const id = created.body.data.device_id;
  const detail = await request(`/devices/${id}`, { token: admin.access_token });
  assert.equal(detail.body.data.actuators.length, 2);
  assert.ok(detail.body.data.actuators.every((a) => a.current_state === "UNKNOWN" && a.desired_state === "OFF"));
  assert.equal((await register()).status, 409);
  assert.equal((await register({ device_code: "CTRL_02" })).status, 409);
  assert.equal((await register({ device_code: "CTRL/#" })).status, 400);
  assert.equal((await request(`/devices/${id}`, { method: "PATCH", token: admin.access_token, body: { lifecycle_status: "ACTIVE" } })).status, 400);
  await pool.query("UPDATE rooms SET status='INACTIVE' WHERE room_id=$1", [room.room_id]);
  assert.equal((await register({ device_code: "SENSOR_01", device_type: "SENSOR_NODE" })).status, 409);
});

test("unassigned device can be retired once with confirmation and immutable history", async (t) => {
  const { register, request, admin, action, pool } = await fixture(t);
  const created = await register({ room_id: undefined });
  assert.equal(created.status, 201);
  const id = created.body.data.device_id;
  assert.equal((await action(id, "decommission")).status, 400);
  const retired = await action(id, "decommission", { confirmed: true });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.data.room_id, null);
  assert.equal(retired.body.data.lifecycle_status, "DECOMMISSIONED");
  assert.equal((await action(id, "decommission", { confirmed: true })).status, 409);
  assert.equal((await request(`/devices/${id}`, { method: "PATCH", token: admin.access_token, body: { device_name: "Changed" } })).status, 409);
  assert.equal((await register({ room_id: undefined })).status, 409);
  const history = await request(`/devices/${id}/lifecycle-events`, { token: admin.access_token });
  assert.equal(history.body.meta.total, 2);
  assert.equal(history.body.data[0].to_status, "DECOMMISSIONED");
  await assert.rejects(() => pool.query("DELETE FROM device_lifecycle_events"), (e) => e.code === "42501");
  await assert.rejects(() => pool.query("TRUNCATE device_lifecycle_events"), (e) => e.code === "42501");
});

test("maintenance and recovery validate lifecycle independently of fresh connectivity", async (t) => {
  const { register, action, pool } = await fixture(t);
  const id = (await register()).body.data.device_id;
  assert.equal((await action(id, "maintenance")).status, 409);
  // Represents a device already provisioned/activated by BE-07, not a bypass in the HTTP API.
  await pool.query("UPDATE devices SET lifecycle_status='ACTIVE',connection_status='ONLINE',last_seen=now(),last_heartbeat_at=now() WHERE device_id=$1", [id]);
  const maintenance = await action(id, "maintenance");
  assert.equal(maintenance.status, 200);
  assert.equal(maintenance.body.data.connection_status, "ONLINE");
  await pool.query("UPDATE devices SET last_seen=now()-interval '31 seconds',last_heartbeat_at=now()-interval '31 seconds' WHERE device_id=$1", [id]);
  assert.equal((await action(id, "resume")).status, 409);
  await pool.query("UPDATE devices SET last_seen=now(),last_heartbeat_at=now() WHERE device_id=$1", [id]);
  assert.equal((await action(id, "resume")).body.data.lifecycle_status, "ACTIVE");
  assert.equal((await action(id, "clear-fault")).status, 409);
  await pool.query("UPDATE devices SET lifecycle_status='FAULT',fault_counters='{\"sensor_err\":5}' WHERE device_id=$1", [id]);
  assert.equal((await action(id, "clear-fault")).status, 200);
  assert.deepEqual((await pool.query("SELECT fault_counters FROM devices WHERE device_id=$1", [id])).rows[0].fault_counters, {});
  assert.equal((await action(id, "decommission", { confirmed: true })).status, 409);
});

test("device lists, filters, details and lifecycle history respect room scope", async (t) => {
  const { register, request, admin, room, login } = await fixture(t);
  const device = (await register()).body.data;
  const otherRoom = (await request("/rooms", { method: "POST", token: admin.access_token, body: { room_code: "ROOM_303", room_name: "Other" } })).body.data;
  const other = (await register({ device_code: "CTRL_02", room_id: otherRoom.room_id })).body.data;
  const viewer = await login("demo_viewer");
  assert.equal((await request(`/rooms/${room.room_id}/users`, { method: "PUT", token: admin.access_token, body: { user_ids: [viewer.user.user_id] } })).status, 200);
  const token = (await login("demo_viewer")).access_token;
  assert.equal((await request("/devices", { token })).body.meta.total, 1);
  assert.equal((await request(`/devices?room_id=${otherRoom.room_id}`, { token })).body.meta.total, 0);
  assert.equal((await request(`/devices/${device.device_id}`, { token })).status, 200);
  assert.equal((await request(`/devices/${other.device_id}`, { token })).status, 404);
  assert.equal((await request(`/devices/${other.device_id}/lifecycle-events`, { token })).status, 404);
  assert.equal((await request(`/devices/${device.device_id}/maintenance`, { method: "POST", token, body: { reason: "Forbidden" } })).status, 403);
  assert.equal((await request("/devices", { method: "POST", token, body: {} })).status, 403);
});

test("concurrent lifecycle changes apply once and failed audit rolls back transition", async (t) => {
  const { register, action, pool, owner } = await fixture(t);
  const id = (await register()).body.data.device_id;
  await pool.query("UPDATE devices SET lifecycle_status='ACTIVE',connection_status='ONLINE',last_seen=now(),last_heartbeat_at=now() WHERE device_id=$1", [id]);
  const results = await Promise.all([action(id, "maintenance"), action(id, "maintenance")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await pool.query("SELECT * FROM device_lifecycle_events WHERE to_status='MAINTENANCE'")).rowCount, 1);
  await owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_resume CHECK(action <> 'DEVICE_RESUME') NOT VALID");
  assert.equal((await action(id, "resume")).status, 500);
  assert.equal((await pool.query("SELECT lifecycle_status FROM devices WHERE device_id=$1", [id])).rows[0].lifecycle_status, "MAINTENANCE");
  assert.equal((await pool.query("SELECT * FROM device_lifecycle_events WHERE to_status='ACTIVE'")).rowCount, 0);
});
