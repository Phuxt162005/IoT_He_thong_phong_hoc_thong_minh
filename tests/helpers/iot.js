import { randomBytes } from "node:crypto";
import { once } from "node:events";
import mqtt from "mqtt";
import { testDatabase } from "./database.js";
import { testHttp } from "./http.js";
import { seed } from "../../backend/src/database/seed.js";
import { loadConfig } from "../../backend/src/config.js";
import { DynamicSecurity } from "../../backend/src/mqtt/dynamic-security.js";
import { MqttRuntime } from "../../backend/src/mqtt/runtime.js";
import { DeviceCredentialsService } from "../../backend/src/modules/device-credentials/device-credentials.service.js";
import { LoggingService } from "../../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../../backend/src/modules/monitoring-logging/logging.sinks.js";
import { DevicePresenceService, bindPresence } from "../../backend/src/modules/device-presence/device-presence.service.js";
import { CommandsService, bindCommands } from "../../backend/src/modules/commands/commands.service.js";
import { DeviceConfigService, bindDeviceConfig } from "../../backend/src/modules/device-config/device-config.service.js";
import { AlertsService } from "../../backend/src/modules/alerts/alerts.service.js";

export async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("Timed out waiting for MQTT/database state");
}

export async function iotFixture(t) {
  let runtime, adminBroker;
  const identities = [];
  const clients = [];
  // Register before the DB cleanup hook: stop message producers before closing pools.
  t.after(async () => {
    await runtime?.stop();
    for (const client of clients) await client.endAsync(true);
    for (const username of identities) if (await adminBroker.getClient(username)) await adminBroker.request({ command: "deleteClient", username });
  });
  const db = await testDatabase(t);
  const mqttUrl = process.env.TEST_MQTT_URL;
  if (!mqttUrl || new URL(mqttUrl).port !== "1885") throw new Error("MQTT integration requires isolated TEST_MQTT_URL on port 1885");
  const backendId = `B_${randomBytes(8).toString("hex")}`;
  const config = loadConfig({ JWT_SECRET: randomBytes(48).toString("hex"), MQTT_URL: mqttUrl, MQTT_USERNAME: backendId, MQTT_CLIENT_ID: backendId, MQTT_PASSWORD: randomBytes(24).toString("hex"), MQTT_ADMIN_PASSWORD: process.env.TEST_MQTT_ADMIN_PASSWORD, DEVICE_SECRET_KEY: randomBytes(32).toString("hex") }, { requireBroker: true });
  adminBroker = new DynamicSecurity({ url: mqttUrl, password: config.mqttAdminPassword });
  identities.push(backendId);
  await adminBroker.setIdentity({ username: backendId, password: config.mqttPassword, clientId: backendId, role: "backend_role" });
  const serviceInput = { pool: db.pool, admin: adminBroker, secretKey: config.deviceSecretKey, mqttUrl };
  const credentials = new DeviceCredentialsService(serviceInput);
  const sink = new MemoryLogSink();
  const logger = new LoggingService({ sink });
  runtime = new MqttRuntime({ config, pool: db.pool, logger, clean: true });
  const presence = new DevicePresenceService({ pool: db.pool, timeoutSeconds: config.heartbeatTimeoutSeconds });
  const unbindPresence = bindPresence(runtime, presence);
  t.after(unbindPresence);
  const commands = new CommandsService({ pool: db.pool, mqtt: runtime, logger });
  const unbindCommands = bindCommands(runtime, commands);
  t.after(unbindCommands);
  const configs = new DeviceConfigService({ pool: db.pool, mqtt: runtime });
  const unbindConfigs = bindDeviceConfig(runtime, configs);
  t.after(unbindConfigs);
  const alerts = new AlertsService({ pool: db.pool });
  await once(runtime, "ready", { signal: AbortSignal.timeout(5000) });
  const password = "iot-test-password-only";
  await seed(db.pool, { username: "test_admin", password });
  const http = await testHttp(t, db.pool, { config, credentials, commands, configs, alerts });
  const adminUser = (await http.request("/auth/login", { method: "POST", body: { username: "test_admin", password } })).body.data;
  const token = adminUser.access_token;
  const room = (await http.request("/rooms", { method: "POST", token, body: { room_code: "ROOM_302", room_name: "Room" } })).body.data;
  const register = async (type = "SENSOR_NODE") => {
    const device_code = `T_${randomBytes(8).toString("hex")}`;
    identities.push(device_code);
    const response = await http.request("/devices", { method: "POST", token, body: { device_code, device_name: type, device_type: type, room_id: room.room_id, firmware_version: "test-1" } });
    if (response.status !== 201) throw new Error("Device fixture registration failed");
    return response.body.data;
  };
  const action = (id, name, extra = {}) => http.request(`/devices/${id}/${name}`, { method: "POST", token, body: { reason: "Integration test", ...extra } });
  const connect = async (credential, overrides = {}) => {
    const client = await mqtt.connectAsync(mqttUrl, { username: credential.username, password: credential.password, clientId: credential.client_id, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 2000, ...overrides });
    client.on("error", () => {});
    clients.push(client);
    return client;
  };
  const activateNode = async (type) => {
    const device = await register(type);
    const provisioned = await action(device.device_id, "provision");
    if (provisioned.status !== 200) throw new Error("Device fixture provisioning failed");
    const client = await connect(provisioned.body.data.credentials);
    const topic = `smartclassroom/room/${room.room_code}/device/${device.device_code}`;
    await client.publishAsync(`${topic}/heartbeat`, JSON.stringify({ msg_id: "hb-1", device_id: device.device_code, room_id: room.room_code, session_id: "boot-1", timestamp: Date.now(), uptime_seconds: 10, free_heap_bytes: 100000, wifi_rssi_dbm: -50 }), { qos: 1 });
    await waitFor(async () => (await db.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [device.device_id])).rows[0].connection_status === "ONLINE");
    if ((await action(device.device_id, "activate")).status !== 200) throw new Error("Device fixture activation failed");
    return { device, client, topic };
  };
  return { ...db, ...http, config, logger, mqttSink: sink, adminBroker, serviceInput, credentials, commands, configs, alerts, runtime, presence, token, room, register, action, connect,
    activateSensor: () => activateNode("SENSOR_NODE"), activateControl: () => activateNode("CONTROL_NODE") };
}
