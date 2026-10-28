import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { TelemetryPipeline, bindTelemetry } from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";
import { AutomationService } from "../../backend/src/modules/automation/automation.service.js";

async function fixture(t) {
  const f = await iotFixture(t);
  t.after(bindTelemetry(f.runtime, new TelemetryPipeline({ pool: f.pool, mqtt: f.runtime, logger: f.logger })));
  const sensor = await f.activateSensor();
  const control = await f.activateControl();
  const received = [];
  control.client.on("message", (topic, raw) => { if (topic === `${control.topic}/command`) received.push(JSON.parse(raw)); });
  await control.client.subscribeAsync(`${control.topic}/command`, { qos: 1 });
  const sample = async (extra = {}, { msgId = randomUUID(), time = Date.now() } = {}) => {
    await sensor.client.publishAsync(`${sensor.topic}/telemetry`, JSON.stringify({ msg_id: msgId, device_id: sensor.device.device_code, room_id: f.room.room_code, timestamp: time, data: { temperature: 32, humidity: 65, lux: 100, occupancy: true, ...extra } }), { qos: 1 });
    await waitFor(async () => (await f.pool.query("SELECT data_id FROM sensor_data WHERE msg_id=$1", [msgId])).rowCount === 1);
    return msgId;
  };
  const rule = (extra = {}, token = f.token) => f.request(`/rooms/${f.room.room_id}/automation-rules`, { method: "POST", token, body: { name: "Hot room fan", target_device_id: control.device.device_id, actuator: "FAN", action: "ON", condition: { all: [{ metric: "temperature", operator: "GT", value: 30 }, { metric: "occupancy", operator: "EQ", value: true }] }, hold_seconds: 0, cooldown_seconds: 30, priority: 10, is_enabled: true, ...extra } });
  const commands = async () => (await f.pool.query("SELECT * FROM commands ORDER BY shadow_version")).rows;
  return { ...f, sensor, control, sample, rule, received, commandRows: commands };
}

test("automation commits one durable command, publishes through the shared MQTT/ACK path and survives replay/restart", async (t) => {
  const f = await fixture(t);
  const rule = await f.rule(); assert.equal(rule.status, 201);
  const time = Date.now();
  const msgId = await f.sample({}, { time });
  assert.equal((await Promise.all([f.automation.tick(), f.automation.tick()])).reduce((a, b) => a + b), 1);
  const command = (await f.commandRows())[0];
  assert.equal(command.source, "AUTOMATION"); assert.equal(command.rule_id, rule.body.data.rule_id);
  assert.equal(command.published_at, null);
  assert.equal(await new AutomationService({ pool: f.pool, commands: f.commands }).tick(), 0);
  await f.commands.processPending();
  await waitFor(() => f.received.length === 1);
  await f.control.client.publishAsync(`${f.control.topic}/ack`, JSON.stringify({ command_id: command.command_id, device_id: f.control.device.device_code, room_id: f.room.room_code, session_id: "boot-1", shadow_version: command.shadow_version, status: "SUCCESS", reported_state: { fan: "ON" }, timestamp: Date.now() }), { qos: 1 });
  await waitFor(async () => (await f.commandRows())[0].status === "SUCCESS");
  await f.sample({}, { msgId, time });
  await f.pool.query("UPDATE automation_rule_state SET last_triggered_at=now()-interval '1 hour'");
  assert.equal(await f.automation.tick(), 0);
  assert.equal((await f.commandRows()).length, 1);
});

test("hold and cooldown persist; priority resolves competing rules without oscillation", async (t) => {
  const f = await fixture(t);
  const winner = (await f.rule({ hold_seconds: 5, priority: 1 })).body.data;
  await f.rule({ name: "Lower priority off", action: "OFF", hold_seconds: 5, priority: 20 });
  await f.sample();
  assert.equal(await f.automation.tick(), 0);
  await f.pool.query("UPDATE automation_rule_state SET true_since=now()-interval '1 minute',last_evaluated_at=now()-interval '1 minute'");
  assert.equal(await f.automation.tick(), 0);
  await f.pool.query("UPDATE automation_rule_state SET true_since=now()-interval '6 seconds'");
  assert.equal(await new AutomationService({ pool: f.pool, commands: f.commands }).tick(), 1);
  assert.equal((await f.commandRows())[0].rule_id, winner.rule_id);
  await f.pool.query("UPDATE commands SET timeout_at=now()-interval '1 second'");
  await f.commands.expirePending();
  await f.sample({ temperature: 33 });
  assert.equal(await f.automation.tick(), 0);
  await f.pool.query("UPDATE automation_rule_state SET last_triggered_at=now()-interval '31 seconds'");
  assert.equal(await f.automation.tick(), 1);
  assert.deepEqual((await f.commandRows())[1].desired_state, { fan: "ON" });
});

test("manual override and explicit mode prevent automation; stale/backfill data and FAULT cannot trigger", async (t) => {
  const f = await fixture(t);
  await f.rule();
  await f.sample({}, { time: Date.now() - 60000 });
  assert.equal(await f.automation.tick(), 0);
  await f.sample();
  const manual = await f.request(`/devices/${f.control.device.device_id}/commands`, { method: "POST", token: f.token, body: { desired_state: { fan: "OFF" } } });
  assert.equal(manual.status, 202); assert.equal(await f.automation.tick(), 0);
  const mode = (control_mode) => f.request(`/devices/${f.control.device.device_id}/control-mode`, { method: "PUT", token: f.token, body: { control_mode, reason: "Integration mode" } });
  assert.equal((await mode("MANUAL")).status, 200);
  assert.equal(await f.automation.tick(), 0);
  await f.pool.query("UPDATE commands SET timeout_at=now()-interval '1 second'");
  await f.commands.expirePending();
  assert.equal((await mode("AUTO")).status, 200);
  await f.action(f.control.device.device_id, "maintenance");
  assert.equal(await f.automation.tick(), 0);
  await f.action(f.control.device.device_id, "recover");
  assert.equal(await f.automation.tick(), 1);
});

test("rule validation rejects executable/unknown/deep expressions and foreign-room targets; writes require Admin", async (t) => {
  const f = await fixture(t);
  for (const condition of ["temperature > 30", { metric: "unknown", operator: "GT", value: 3 }, { metric: "occupancy", operator: "GT", value: true }, { all: [] }, { all: [{ any: [{ all: [{ any: [{ all: [{ metric: "lux", operator: "GT", value: 3 }] }] }] }] }] }]) assert.equal((await f.rule({ condition })).status, 400);
  assert.equal((await f.rule({ target_device_id: f.sensor.device.device_id })).status, 400);
  const user = (await f.request("/users", { method: "POST", token: f.token, body: { username: "rule_viewer", display_name: "Viewer", password: "automation-viewer-password", role: "VIEWER" } })).body.data;
  let token = (await f.request("/auth/login", { method: "POST", body: { username: user.username, password: "automation-viewer-password" } })).body.data.access_token;
  assert.equal((await f.rule({}, token)).status, 403);
  assert.equal((await f.request(`/rooms/${f.room.room_id}/automation-rules`, { token })).status, 404);
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: [user.user_id] } });
  token = (await f.request("/auth/login", { method: "POST", body: { username: user.username, password: "automation-viewer-password" } })).body.data.access_token;
  assert.equal((await f.request(`/rooms/${f.room.room_id}/automation-rules`, { token })).status, 200);
  assert.equal((await f.request(`/devices/${f.control.device.device_id}/control-mode`, { method: "PUT", token, body: { control_mode: "AUTO", reason: "No permission" } })).status, 403);
});

test("disabled or no-longer-matching rules cancel unpublished commands before the broker sees them", async (t) => {
  const f = await fixture(t);
  const rule = (await f.rule()).body.data;
  await f.sample(); assert.equal(await f.automation.tick(), 1);
  assert.equal((await f.request(`/automation-rules/${rule.rule_id}`, { method: "PATCH", token: f.token, body: { is_enabled: false } })).status, 200);
  await f.commands.processPending();
  assert.equal((await f.commandRows())[0].status, "FAILED");
  assert.equal(f.received.length, 0);
});

test("automation audit failure rolls back command, shadow and trigger state for safe retry", async (t) => {
  const f = await fixture(t);
  await f.rule(); await f.sample();
  await f.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_no_automation CHECK(action <> 'COMMAND_CREATE') NOT VALID");
  await assert.rejects(f.automation.tick());
  assert.equal((await f.commandRows()).length, 0);
  assert.equal((await f.pool.query("SELECT last_triggered_at FROM automation_rule_state")).rows[0].last_triggered_at, null);
  await f.owner.query("ALTER TABLE audit_logs DROP CONSTRAINT test_no_automation");
  assert.equal(await f.automation.tick(), 1);
});
