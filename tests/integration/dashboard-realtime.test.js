import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { iotFixture, waitFor } from "../helpers/iot.js";
import { TelemetryPipeline, bindTelemetry } from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";
import { attachRealtime } from "../../backend/src/modules/realtime/realtime.js";
import { enqueueIotEvent } from "../../backend/src/database/events.js";
import { withTransaction } from "../../backend/src/database/pool.js";
import { csvCell } from "../../backend/src/modules/dashboard/dashboard.service.js";
import { AuthService } from "../../backend/src/modules/auth/auth.service.js";

async function fixture(t, realtime = false) {
  let hub; const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await hub?.stop(); });
  const f = await iotFixture(t);
  t.after(bindTelemetry(f.runtime, new TelemetryPipeline({ pool: f.pool, mqtt: f.runtime, logger: f.logger })));
  const sensor = await f.activateSensor();
  if (realtime) {
    hub = attachRealtime({ server: f.server, pool: f.pool, config: f.config, logger: f.logger, authTimeoutMs: 500, checkIntervalMs: 100, maxConnectionsPerUser: 2 });
    await waitFor(() => hub.ready());
  }
  const sample = async (temperature = 28, { timestamp = Date.now(), msg_id = randomUUID() } = {}) => {
    await sensor.client.publishAsync(`${sensor.topic}/telemetry`, JSON.stringify({ msg_id, device_id: sensor.device.device_code, room_id: f.room.room_code, timestamp, data: { temperature, humidity: 60, lux: 200, occupancy: true } }), { qos: 1 });
    await waitFor(async () => (await f.pool.query("SELECT data_id FROM sensor_data WHERE msg_id=$1", [msg_id])).rowCount === 1);
    return msg_id;
  };
  const socket = async (token, options = {}) => {
    const ws = new WebSocket(`${f.base.replace("http", "ws")}${options.path ?? "/ws"}`, options.origin ? { origin: options.origin } : {});
    ws.on("error", () => {}); sockets.push(ws);
    const messages = []; ws.on("message", (raw) => messages.push(JSON.parse(raw)));
    await once(ws, "open");
    if (token) { ws.send(JSON.stringify({ type: "authenticate", token })); await waitFor(() => messages.some((m) => m.type === "authenticated") || ws.readyState === WebSocket.CLOSED); }
    return { ws, messages };
  };
  const viewer = async (assigned = true) => {
    const password = "dashboard-viewer-test-password";
    const user = (await f.request("/users", { method: "POST", token: f.token, body: { username: "dash_viewer", display_name: "Viewer", password, role: "VIEWER" } })).body.data;
    if (assigned) await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: [user.user_id] } });
    return { user, token: (await f.request("/auth/login", { method: "POST", body: { username: user.username, password } })).body.data.access_token };
  };
  return { ...f, sensor, sample, socket, viewer, hub };
}

test("history preserves measured time, pagination and latest; stats use UTC buckets and exclude clock-skew", async (t) => {
  const f = await fixture(t);
  await f.sample(20, { timestamp: Date.now() - 60000 });
  await f.sample(30); await f.sample(40, { timestamp: Date.now() + 600000 });
  const path = `/rooms/${f.room.room_id}/telemetry`;
  const history = await f.request(`${path}?page_size=2`, { token: f.token });
  assert.equal(history.status, 200); assert.equal(history.body.meta.total, 3); assert.equal(history.body.data.length, 2);
  assert.equal(history.body.data[0].payload_hash, undefined);
  assert.equal((await f.request(`${path}/latest`, { token: f.token })).body.data[0].temperature, 30);
  const stats = await f.request(`${path}/stats?bucket=day`, { token: f.token });
  assert.equal(stats.status, 200); assert.equal(stats.body.data[0].sample_count, 2); assert.equal(stats.body.data[0].temperature_avg, 25);
  assert.equal(stats.body.data[0].occupied_samples, 2);
  assert.match(stats.body.data[0].bucket_at, /T00:00:00\.000Z$/);
  const dashboard = await f.request("/dashboard", { token: f.token });
  assert.equal(dashboard.body.data.rooms_count, 1); assert.equal(dashboard.body.data.latest_telemetry[0].temperature, 30);
  assert.equal((await f.request(`/devices/${f.sensor.device.device_id}/telemetry?page=2&page_size=2`, { token: f.token })).body.data.length, 1);
});

test("history ranges and CSV are bounded and escaped, with authorization on every export and filter", async (t) => {
  const f = await fixture(t);
  await f.sample();
  const { token } = await f.viewer(false);
  const path = `/rooms/${f.room.room_id}/telemetry`;
  for (const suffix of ["", "/latest", "/stats", "/export"]) assert.equal((await f.request(`${path}${suffix}`, { token })).status, 404);
  assert.equal((await f.request("/dashboard", { token })).body.data.rooms_count, 0);
  assert.equal((await f.request(`${path}?from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z`, { token: f.token })).status, 400);
  assert.equal((await f.request(`${path}?from=invalid`, { token: f.token })).status, 400);
  assert.equal((await f.request(`${path}?page_size=101`, { token: f.token })).status, 400);
  const csv = await fetch(`${f.base}/api/v1${path}/export`, { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /temperature,humidity,lux,occupancy/);
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  await f.owner.query(`INSERT INTO sensor_data(device_id,room_id,msg_id,recorded_at,received_at,temperature,humidity,lux,payload_hash)
    SELECT $1,$2,'BULK_' || x,now(),now(),25,50,100,repeat('0',64) FROM generate_series(1,5001) x`, [f.sensor.device.device_id, f.room.room_id]);
  assert.equal((await f.request(`${path}/export`, { token: f.token })).status, 413);
});

test("WebSocket authenticates first, scopes committed telemetry and measures publish-to-browser delay", async (t) => {
  const f = await fixture(t, true);
  const viewer = await f.viewer(true);
  const session = await f.socket(viewer.token);
  assert.equal(session.messages[0].snapshot_required, true);
  const transaction = await f.pool.connect();
  await transaction.query("BEGIN");
  const id = await enqueueIotEvent(transaction, "alert.updated", { room_id: f.room.room_id, status: "OPEN" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(session.messages.some((m) => m.event_id === id), false);
  await transaction.query("COMMIT"); transaction.release();
  await waitFor(() => session.messages.some((m) => m.event_id === id));
  const started = performance.now(); await f.sample();
  await waitFor(() => session.messages.some((m) => m.type === "telemetry.stored"));
  const elapsed = performance.now() - started;
  t.diagnostic(`Local MQTT publish to WebSocket delivery: ${elapsed.toFixed(1)} ms`);
  const message = session.messages.find((m) => m.type === "telemetry.stored");
  assert.equal(message.payload.telemetry.temperature, 28); assert.equal(message.payload.telemetry.payload_hash, undefined);
  const other = (await f.request("/rooms", { method: "POST", token: f.token, body: { room_code: "ROOM_999", room_name: "Other" } })).body.data;
  await withTransaction(f.pool, (client) => enqueueIotEvent(client, "alert.created", { room_id: other.room_id, alert_id: "999" }));
  await f.sample(29);
  await waitFor(() => session.messages.filter((m) => m.type === "telemetry.stored").length === 2);
  assert.equal(session.messages.some((m) => m.payload?.room_id === other.room_id), false);
});

test("open WebSocket sessions close after logout, account/scope change and JWT expiry", async (t) => {
  const f = await fixture(t, true);
  const viewer = await f.viewer(true);
  let session = await f.socket(viewer.token);
  const closed = once(session.ws, "close");
  await f.request(`/rooms/${f.room.room_id}/users`, { method: "PUT", token: f.token, body: { user_ids: [] } });
  assert.equal((await closed)[0], 4001);
  const current = (await f.pool.query("SELECT user_id,token_version FROM users WHERE user_id=$1", [viewer.user.user_id])).rows[0];
  const shortToken = await new AuthService({ pool: f.pool, jwtSecret: f.config.jwtSecret, jwtExpiresIn: 2 }).issueToken(current);
  const expiring = await f.socket(shortToken);
  assert.equal((await once(expiring.ws, "close"))[0], 4001);
  session = await f.socket(f.token);
  const loggedOut = once(session.ws, "close");
  await f.request("/auth/logout", { method: "POST", token: f.token });
  assert.equal((await loggedOut)[0], 4001);
  assert.equal(f.mqttSink.entries?.some?.((line) => JSON.stringify(line).includes(f.token)) ?? false, false);
});

test("WebSocket rejects missing/invalid auth, excessive connections, forbidden origins and JWT query strings", async (t) => {
  const f = await fixture(t, true);
  const pending = await f.socket();
  const missing = once(pending.ws, "close");
  await f.sample();
  assert.equal((await missing)[0], 4001); assert.equal(pending.messages.length, 0);
  const invalid = await f.socket("invalid");
  await waitFor(() => invalid.ws.readyState === WebSocket.CLOSED);
  await f.socket(f.token); await f.socket(f.token);
  const extra = await f.socket(f.token);
  await waitFor(() => extra.ws.readyState === WebSocket.CLOSED);
  assert.equal(extra.messages.some((m) => m.type === "authenticated"), false);
  await assert.rejects(f.socket(f.token, { origin: "https://forbidden.example" }));
  await assert.rejects(f.socket(null, { path: "/ws?token=do-not-log" }));
});

test("loss of the database notification connection closes sockets; reconnect requires a fresh HTTP snapshot", async (t) => {
  const f = await fixture(t, true);
  const session = await f.socket(f.token);
  const closed = once(session.ws, "close");
  const result = await f.owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND query=$1", [`LISTEN "smartclass_iot_${f.schema}"`]);
  assert.equal(result.rowCount, 1);
  await closed;
  await waitFor(() => f.hub.ready());
  const reconnected = await f.socket(f.token);
  assert.equal(reconnected.messages[0].snapshot_required, true);
  await f.sample();
  await waitFor(() => reconnected.messages.some((m) => m.type === "telemetry.stored"));
});
