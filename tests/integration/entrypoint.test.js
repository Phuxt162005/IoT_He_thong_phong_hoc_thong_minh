import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { iotFixture, waitFor } from "../helpers/iot.js";

test("real server entrypoint runs telemetry, alerts, automation, ACK/config, restart recovery and revocation end to end", async (t) => {
  let child, ws, output = "";
  const stop = async () => {
    ws?.terminate(); ws = null;
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
  };
  t.after(stop);
  const f = await iotFixture(t);
  const sensor = await f.activateSensor(); const control = await f.activateControl();
  await f.runtime.stop();
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set("options", `-c search_path=${f.schema}`);
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    child = spawn(process.execPath, ["backend/src/server.js"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: url.toString(),
      JWT_SECRET: f.config.jwtSecret, MQTT_URL: f.config.mqttUrl, MQTT_USERNAME: f.config.mqttUsername,
      MQTT_PASSWORD: f.config.mqttPassword, MQTT_CLIENT_ID: f.config.mqttClientId, MQTT_ADMIN_USERNAME: "admin",
      MQTT_ADMIN_PASSWORD: f.config.mqttAdminPassword, DEVICE_SECRET_KEY: f.config.deviceSecretKey,
      RETENTION_ENABLED: "false", MANUAL_OVERRIDE_S: "60", COMMAND_TIMEOUT_S: "5",
    } });
    child.stdout.on("data", (raw) => { output += raw; }); child.stderr.on("data", (raw) => { output += raw; });
    child.on("error", () => {});
    await waitFor(async () => { if (child.exitCode !== null) throw new Error("Entrypoint exited unexpectedly"); try { return (await fetch(`${base}/ready`)).ok; } catch { return false; } });
  };
  let token;
  const request = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  let acknowledge = true;
  control.client.on("message", async (topic, raw) => {
    if (topic !== `${control.topic}/command` || !acknowledge) return;
    const command = JSON.parse(raw);
    await control.client.publishAsync(`${control.topic}/ack`, JSON.stringify({ ...command, expires_at: undefined, status: "SUCCESS", reported_state: command.desired_state, desired_state: undefined, timestamp: Date.now() }), { qos: 1 });
  });
  await control.client.subscribeAsync(`${control.topic}/command`, { qos: 1 });
  sensor.client.on("message", async (topic, raw) => {
    if (topic !== `${sensor.topic}/config`) return;
    const config = JSON.parse(raw);
    await sensor.client.publishAsync(`${sensor.topic}/config/ack`, JSON.stringify({ config_id: config.config_id, device_id: config.device_id, room_id: config.room_id, session_id: config.session_id, version: config.version, status: "SUCCESS", applied_settings: config.settings, timestamp: Date.now() }), { qos: 1 });
  });
  await sensor.client.subscribeAsync(`${sensor.topic}/config`, { qos: 1 });
  await start();
  const login = await request("/auth/login", { username: "test_admin", password: "iot-test-password-only" });
  assert.equal(login.status, 200); token = login.body.data.access_token;
  ws = new WebSocket(base.replace("http", "ws") + "/ws"); const messages = [];
  ws.on("error", () => {}); ws.on("message", (raw) => messages.push(JSON.parse(raw)));
  await once(ws, "open"); ws.send(JSON.stringify({ type: "authenticate", token }));
  await waitFor(() => messages.some((m) => m.type === "authenticated"));
  const started = performance.now();
  await sensor.client.publishAsync(`${sensor.topic}/telemetry`, JSON.stringify({ msg_id: "e2e-1", device_id: sensor.device.device_code, room_id: f.room.room_code, timestamp: Date.now(), data: { temperature: 36, humidity: 65, lux: 100, occupancy: true } }), { qos: 1 });
  await waitFor(() => messages.some((m) => m.type === "telemetry.stored"));
  t.diagnostic(`Entrypoint MQTT-to-WebSocket: ${(performance.now() - started).toFixed(1)} ms`);
  await waitFor(async () => (await f.pool.query("SELECT * FROM alerts WHERE severity='CRITICAL' AND alert_type='TEMP_HIGH'")).rowCount === 1);
  const rule = await request(`/rooms/${f.room.room_id}/automation-rules`, { name: "E2E hot room", target_device_id: control.device.device_id, actuator: "FAN", action: "ON", condition: { metric: "temperature", operator: "GT", value: 30 }, hold_seconds: 0, cooldown_seconds: 30, priority: 1, is_enabled: true });
  assert.equal(rule.status, 201);
  await waitFor(async () => (await f.pool.query("SELECT * FROM commands WHERE source='AUTOMATION' AND status='SUCCESS'")).rowCount === 1);
  const config = await request(`/devices/${sensor.device.device_id}/configs`, { settings: { sample_interval_seconds: 2, heartbeat_interval_seconds: 5 } });
  assert.equal(config.status, 202);
  await waitFor(async () => (await f.pool.query("SELECT * FROM device_configs WHERE status='SUCCESS'")).rowCount === 1);
  acknowledge = false;
  const pending = await request(`/devices/${control.device.device_id}/commands`, { desired_state: { fan: "OFF" }, timeout_seconds: 3 });
  assert.equal(pending.status, 202);
  await stop(); await start();
  assert.equal((await request(`/rooms/${f.room.room_id}/telemetry`)).body.meta.total, 1);
  await waitFor(async () => (await f.pool.query("SELECT status FROM commands WHERE command_id=$1", [pending.body.data.command.command_id])).rows[0].status === "TIMEOUT");
  const shadow = await request(`/devices/${control.device.device_id}/shadow`);
  assert.equal(shadow.body.data.desired_state.fan, "OFF"); assert.equal(shadow.body.data.reported_state.fan, "ON");
  assert.equal((await request(`/devices/${sensor.device.device_id}/revoke`, { reason: "E2E revoke", confirmed: true })).status, 200);
  await waitFor(() => !sensor.client.connected);
  assert.equal((await request("/audit-logs?action=COMMAND_RESULT")).body.meta.total, 2);
  for (const secret of [token, f.config.mqttPassword, f.config.mqttAdminPassword, f.config.jwtSecret, f.config.deviceSecretKey, "iot-test-password-only"]) assert.equal(output.includes(secret), false);
});
