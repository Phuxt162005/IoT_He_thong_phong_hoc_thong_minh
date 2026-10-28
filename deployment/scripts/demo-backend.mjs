import "dotenv/config";
import mqtt from "mqtt";
import { randomBytes, randomUUID } from "node:crypto";
const base = (process.env.BASE_URL ?? "http://127.0.0.1:3000") + "/api/v1";
const clients = []; const devices = []; let token, room;
async function api(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.code ?? "API_FAILED"); return result.data;
}
async function until(read, check) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (check(value)) return value; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("DEMO_TIMEOUT");
}
try {
  token = (await api("/auth/login", { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })).access_token;
  const suffix = randomBytes(6).toString("hex");
  room = await api("/rooms", { room_code: `CHECK_${suffix}`, room_name: "BE-16 simulated backend verification" });
  for (const type of ["SENSOR_NODE", "CONTROL_NODE"]) {
    const device = await api("/devices", { device_code: `${type === "SENSOR_NODE" ? "S" : "C"}_${suffix}`, device_name: `Simulated ${type}`, device_type: type, room_id: room.room_id });
    devices.push(device);
    const issued = await api(`/devices/${device.device_id}/provision`, { reason: "BE-16 simulated verification" });
    const credential = issued.credentials;
    const session = randomUUID(); const topic = `smartclassroom/room/${room.room_code}/device/${device.device_code}`;
    const client = await mqtt.connectAsync(process.env.MQTT_URL, { username: credential.username, password: credential.password, clientId: credential.client_id, protocolVersion: 5, reconnectPeriod: 0 });
    client.on("error", () => {}); clients.push(client);
    client.on("message", async (name, raw) => {
      try {
        const message = JSON.parse(raw);
        if (name === `${topic}/command`) await client.publishAsync(`${topic}/ack`, JSON.stringify({ command_id: message.command_id, device_id: device.device_code, room_id: room.room_code, session_id: session, shadow_version: message.shadow_version, timestamp: Date.now(), status: "SUCCESS", reported_state: message.desired_state }), { qos: 1 });
        if (name === `${topic}/config`) await client.publishAsync(`${topic}/config/ack`, JSON.stringify({ config_id: message.config_id, device_id: device.device_code, room_id: room.room_code, session_id: session, version: message.version, timestamp: Date.now(), status: "SUCCESS", applied_settings: message.settings }), { qos: 1 });
      } catch { /* API waits for the final result and reports a safe error. */ }
    });
    await client.subscribeAsync(`${topic}/${type === "SENSOR_NODE" ? "config" : "command"}`, { qos: 1 });
    await client.publishAsync(`${topic}/heartbeat`, JSON.stringify({ msg_id: randomUUID(), device_id: device.device_code, room_id: room.room_code, session_id: session, timestamp: Date.now(), uptime_seconds: 1, free_heap_bytes: 100000, wifi_rssi_dbm: -50 }), { qos: 1 });
    await until(() => api(`/devices/${device.device_id}`), (d) => d.connection_status === "ONLINE");
    await api(`/devices/${device.device_id}/activate`, { reason: "Simulated heartbeat verified" });
    device.client = client; device.topic = topic;
  }
  const [sensor, control] = devices;
  await sensor.client.publishAsync(`${sensor.topic}/telemetry`, JSON.stringify({ msg_id: randomUUID(), device_id: sensor.device_code, room_id: room.room_code, timestamp: Date.now(), data: { temperature: 36, humidity: 65, lux: 250, occupancy: true } }), { qos: 1 });
  await until(() => api(`/rooms/${room.room_id}/telemetry`), (rows) => rows.length === 1);
  await until(() => api(`/alerts?room_id=${room.room_id}&alert_type=TEMP_HIGH`), (rows) => rows.some((row) => row.severity === "CRITICAL"));
  const command = await api(`/devices/${control.device_id}/commands`, { desired_state: { fan: "ON" } });
  await until(() => api(`/devices/${control.device_id}/commands`), (rows) => rows.some((row) => row.command_id === command.command.command_id && row.status === "SUCCESS"));
  const config = await api(`/devices/${sensor.device_id}/configs`, { settings: { sample_interval_seconds: 2 } });
  await until(() => api(`/devices/${sensor.device_id}/configs`), (value) => value.state.applied_version === config.version);
  console.log(JSON.stringify({ simulated: true, room_id: room.room_id, telemetry: "stored", alert: "CRITICAL", command: "SUCCESS", config: "SUCCESS" }));
} catch { console.error(JSON.stringify({ error: "BACKEND_DEMO_FAILED", room_id: room?.room_id })); process.exitCode = 1; }
finally {
  for (const device of devices) {
    try { await api(`/devices/${device.device_id}/revoke`, { reason: "End simulated verification", confirmed: true }); await api(`/devices/${device.device_id}/decommission`, { reason: "Retain simulated verification history", confirmed: true }); }
    catch { console.error(JSON.stringify({ cleanup_required_device_id: device.device_id })); process.exitCode = 1; }
  }
  for (const client of clients) await client.endAsync(true);
  if (room) try { await api(`/rooms/${room.room_id}`, { status: "INACTIVE" }, "PATCH"); } catch { process.exitCode = 1; }
}
