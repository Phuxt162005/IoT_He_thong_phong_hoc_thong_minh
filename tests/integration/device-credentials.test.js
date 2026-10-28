import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import mqtt from "mqtt";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";
import { loadConfig } from "../../backend/src/config.js";
import { DynamicSecurity } from "../../backend/src/mqtt/dynamic-security.js";
import { MqttRuntime } from "../../backend/src/mqtt/runtime.js";
import { DeviceCredentialsService } from "../../backend/src/modules/device-credentials/device-credentials.service.js";
import { LoggingService } from "../../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../../backend/src/modules/monitoring-logging/logging.sinks.js";

async function waitFor(predicate) {
  for (let i = 0; i < 60; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("Timed out waiting for MQTT state");
}
async function fixture(t) {
  const db = await testDatabase(t);
  const mqttUrl = process.env.TEST_MQTT_URL;
  if (!mqttUrl || new URL(mqttUrl).port !== "1885") throw new Error("MQTT integration requires isolated TEST_MQTT_URL on port 1885");
  const config = loadConfig({ JWT_SECRET: randomBytes(48).toString("hex"), MQTT_URL: mqttUrl, MQTT_PASSWORD: process.env.TEST_MQTT_PASSWORD, MQTT_ADMIN_PASSWORD: process.env.TEST_MQTT_ADMIN_PASSWORD, DEVICE_SECRET_KEY: randomBytes(32).toString("hex") }, { requireBroker: true });
  const adminBroker = new DynamicSecurity({ url: mqttUrl, password: config.mqttAdminPassword });
  const serviceInput = { pool: db.pool, admin: adminBroker, secretKey: config.deviceSecretKey, mqttUrl };
  const credentials = new DeviceCredentialsService(serviceInput);
  const runtime = new MqttRuntime({ config, pool: db.pool, logger: new LoggingService({ sink: new MemoryLogSink() }) });
  await once(runtime, "ready", { signal: AbortSignal.timeout(5000) });
  t.after(() => runtime.stop());
  const password = "credential-test-password-only";
  await seed(db.pool, { username: "test_admin", password });
  const http = await testHttp(t, db.pool, { config, credentials });
  const adminUser = (await http.request("/auth/login", { method: "POST", body: { username: "test_admin", password } })).body.data;
  const token = adminUser.access_token;
  const room = (await http.request("/rooms", { method: "POST", token, body: { room_code: "ROOM_302", room_name: "Room" } })).body.data;
  const identities = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.endAsync(true);
    for (const username of identities) if (await adminBroker.getClient(username)) await adminBroker.request({ command: "deleteClient", username });
  });
  const register = async (type = "SENSOR_NODE") => {
    const device_code = `T_${randomBytes(8).toString("hex")}`;
    identities.push(device_code);
    const response = await http.request("/devices", { method: "POST", token, body: { device_code, device_name: type, device_type: type, room_id: room.room_id, firmware_version: "test-1" } });
    assert.equal(response.status, 201);
    return response.body.data;
  };
  const action = (id, name, extra = {}) => http.request(`/devices/${id}/${name}`, { method: "POST", token, body: { reason: "Integration test", ...extra } });
  const connect = async (credential, overrides = {}) => {
    const client = await mqtt.connectAsync(mqttUrl, { username: credential.username, password: credential.password, clientId: credential.client_id, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 2000, ...overrides });
    client.on("error", () => {});
    clients.push(client);
    return client;
  };
  return { ...db, ...http, config, adminBroker, serviceInput, credentials, runtime, token, room, register, action, connect };
}

test("real broker provisioning requires authenticated heartbeat before activation and never stores plaintext", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  const provision = await f.action(device.device_id, "provision");
  assert.equal(provision.status, 200);
  assert.equal(provision.body.data.operation.status, "APPLIED");
  const secret = provision.body.data.credentials;
  assert.equal((await f.action(device.device_id, "activate")).status, 409);
  const client = await f.connect(secret);
  const topic = `smartclassroom/room/${f.room.room_code}/device/${device.device_code}/heartbeat`;
  await client.publishAsync(topic, JSON.stringify({ msg_id: "hb-1", device_id: device.device_code, room_id: f.room.room_code, session_id: "boot-1", timestamp: Date.now(), uptime_seconds: 10, free_heap_bytes: 100000, wifi_rssi_dbm: -50, firmware_version: "test-1" }), { qos: 1 });
  await waitFor(async () => (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status === "ONLINE");
  assert.equal((await f.action(device.device_id, "activate")).body.data.lifecycle_status, "ACTIVE");
  const stored = (await f.pool.query("SELECT * FROM device_credentials WHERE device_id=$1", [device.device_id])).rows[0];
  assert.ok(stored.secret_hash.startsWith("scrypt-v1$"));
  assert.ok(!JSON.stringify(stored).includes(secret.password));
  assert.equal((await f.pool.query("SELECT secret_encrypted FROM broker_operations WHERE operation_id=$1", [provision.body.data.operation.operation_id])).rows[0].secret_encrypted, null);
  assert.ok(!JSON.stringify(f.sink.getEntries()).includes(secret.password));
  assert.equal((await f.action(device.device_id, "provision")).status, 409);
});

test("broker rejects wrong passwords, wrong client IDs and other-device or command ACL access", async (t) => {
  const f = await fixture(t);
  const sensor = await f.register();
  const control = await f.register("CONTROL_NODE");
  const sensorKey = (await f.action(sensor.device_id, "provision")).body.data.credentials;
  const controlKey = (await f.action(control.device_id, "provision")).body.data.credentials;
  await assert.rejects(() => f.connect(sensorKey, { password: "incorrect-password" }));
  await assert.rejects(() => f.connect(sensorKey, { clientId: control.device_code }));
  const client = await f.connect(sensorKey);
  await client.publishAsync(`smartclassroom/room/ROOM_302/device/${sensor.device_code}/telemetry`, "{}", { qos: 1 });
  await assert.rejects(() => client.publishAsync(`smartclassroom/room/ROOM_302/device/${control.device_code}/telemetry`, "{}", { qos: 1 }));
  const next = await f.connect(sensorKey);
  let denied = false;
  try { denied = (await next.subscribeAsync(`smartclassroom/room/ROOM_302/device/${control.device_code}/command`)).some((g) => g.qos >= 128); } catch { denied = true; }
  assert.equal(denied, true);
  const ctrl = await f.connect(controlKey);
  const grant = await ctrl.subscribeAsync(`smartclassroom/room/ROOM_302/device/${control.device_code}/command`, { qos: 1 });
  assert.ok(grant.every((g) => g.qos < 128));
  await assert.rejects(() => ctrl.publishAsync(`smartclassroom/room/ROOM_302/device/${control.device_code}/command`, "{}", { qos: 1 }));
});

test("rotation and revocation disconnect live sessions and invalidate old credentials on a real broker", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  const old = (await f.action(device.device_id, "provision")).body.data.credentials;
  const client = await f.connect(old);
  const rotated = await f.action(device.device_id, "rotate-credentials");
  assert.equal(rotated.status, 200);
  const fresh = rotated.body.data.credentials;
  assert.notEqual(old.password, fresh.password);
  await waitFor(() => !client.connected);
  await assert.rejects(() => f.connect(old));
  const current = await f.connect(fresh);
  assert.equal((await f.action(device.device_id, "revoke", { confirmed: true })).status, 200);
  await waitFor(() => !current.connected);
  await assert.rejects(() => f.connect(fresh));
  const status = await f.request(`/devices/${device.device_id}/broker-status`, { token: f.token });
  assert.equal(status.body.data.broker_sync_status, "SYNCED");
  assert.equal((await f.pool.query("SELECT lifecycle_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].lifecycle_status, "REVOKED");
  assert.equal((await f.action(device.device_id, "provision")).status, 400);
  assert.equal((await f.action(device.device_id, "provision", { confirmed: true })).status, 200);
});

test("broker failure returns pending; encrypted outbox survives service restart and reconciles against real broker", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  f.credentials.admin = new DynamicSecurity({ url: "mqtt://127.0.0.1:1", password: f.config.mqttAdminPassword });
  const response = await f.action(device.device_id, "provision");
  assert.equal(response.status, 202);
  assert.equal(response.body.data.operation.status, "PENDING");
  const secret = response.body.data.credentials.password;
  const pending = (await f.pool.query("SELECT * FROM broker_operations WHERE device_id=$1", [device.device_id])).rows[0];
  assert.ok(pending.secret_encrypted);
  assert.ok(!pending.secret_encrypted.includes(secret));
  assert.equal((await f.action(device.device_id, "activate")).status, 409);
  assert.equal(await f.adminBroker.getClient(device.device_code), null);
  await f.pool.query("UPDATE broker_operations SET next_retry_at=now() WHERE operation_id=$1", [pending.operation_id]);
  const restarted = new DeviceCredentialsService(f.serviceInput);
  assert.equal(await restarted.processPending(), 1);
  const status = await restarted.status({ user_id: "1", role: "ADMIN" }, device.device_id);
  assert.equal(status.operations[0].status, "APPLIED");
  const client = await f.connect(response.body.data.credentials);
  assert.equal(client.connected, true);
});

test("credential audit failure prevents broker mutation and rolls back database changes", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_credential CHECK(action <> 'DEVICE_CREDENTIAL_ISSUE') NOT VALID");
  assert.equal((await f.action(device.device_id, "provision")).status, 500);
  assert.equal((await f.pool.query("SELECT * FROM device_credentials WHERE device_id=$1", [device.device_id])).rowCount, 0);
  assert.equal((await f.pool.query("SELECT lifecycle_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].lifecycle_status, "REGISTERED");
  assert.equal(await f.adminBroker.getClient(device.device_code), null);
});
