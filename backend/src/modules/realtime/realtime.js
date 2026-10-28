import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { AuthService } from "../auth/auth.service.js";
import { publicTelemetry } from "../dashboard/dashboard.service.js";
import { startJob } from "../../common/scheduler.js";

const eventTypes = new Set(["telemetry.stored", "device.status_changed", "device.lifecycle_changed", "device.mode_changed", "command.updated", "actuator.state_changed", "alert.created", "alert.updated", "config.updated"]);
export function attachRealtime({ server, pool, config, logger, authTimeoutMs = 5000, checkIntervalMs = 5000, maxConnectionsPerUser = 5 }) {
  const auth = new AuthService({ pool, jwtSecret: config.jwtSecret, jwtExpiresIn: config.jwtExpiresIn });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  let client, channel, stopping, stopped = false, listening = false, queue = Promise.resolve(), queued = 0;
  const send = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 262144) { ws.close(1013, "Refresh snapshot and reconnect"); return; }
    ws.send(JSON.stringify(message));
  };
  const closeAll = () => { for (const ws of wss.clients) ws.terminate(); };
  async function validate(ws) {
    try { ws.user = await auth.authenticate(ws.authorization); return true; }
    catch { ws.close(4001, "Authentication expired"); return false; }
  }
  async function broadcast(id) {
    if (stopped || !/^[a-f0-9-]{36}$/.test(id)) return;
    const event = (await pool.query("SELECT * FROM iot_events WHERE event_id=$1", [id])).rows[0];
    if (!event || !eventTypes.has(event.event_type) || !/^[1-9]\d{0,18}$/.test(String(event.payload.room_id ?? ""))) return;
    let payload = event.payload;
    if (event.event_type === "telemetry.stored") {
      const sample = (await pool.query("SELECT * FROM sensor_data WHERE data_id=$1", [event.data_id])).rows[0];
      if (!sample) return;
      payload = { ...payload, telemetry: publicTelemetry(sample) };
    }
    for (const ws of wss.clients) {
      if (!ws.user || !(await validate(ws))) continue;
      const allowed = ws.user.role === "ADMIN" || (await pool.query("SELECT room_id FROM user_rooms WHERE user_id=$1 AND room_id=$2", [ws.user.user_id, payload.room_id])).rowCount;
      if (allowed) send(ws, { type: event.event_type, event_id: event.event_id, timestamp: event.created_at, payload });
    }
  }
  async function listen() {
    if (client || stopped) return;
    const connection = await pool.connect();
    if (stopped) { connection.release(); return; }
    client = connection;
    connection.on("error", () => { listening = false; closeAll(); if (client === connection) { client = null; connection.release(true); } });
    connection.on("notification", ({ channel: source, payload }) => {
      if (source !== channel) return;
      if (++queued > 500) { queued--; closeAll(); return; }
      queue = queue.then(() => broadcast(payload)).catch(() => { logger.error("realtime.delivery_failed"); closeAll(); }).finally(() => queued--);
    });
    try {
      const schema = (await connection.query("SELECT current_schema() AS schema")).rows[0].schema;
      channel = `smartclass_iot_${schema}`;
      if (!/^[a-zA-Z0-9_]{1,63}$/.test(channel)) throw new Error("Invalid notification channel");
      await connection.query(`LISTEN "${channel}"`); listening = true;
    } catch (error) { if (client === connection) { client = null; connection.release(true); } throw error; }
  }
  const upgrade = (req, socket, head) => {
    if (req.url !== "/ws" || !listening || stopped || (req.headers.origin && !config.corsOrigins.includes(req.headers.origin)) || wss.clients.size >= 500 || [...wss.clients].filter((ws) => !ws.user && ws.remoteAddress === socket.remoteAddress).length >= 10) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.remoteAddress = socket.remoteAddress; wss.emit("connection", ws); });
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (ws) => {
    ws.alive = true; let authenticating = false;
    const timer = setTimeout(() => ws.close(4001, "Authenticate first"), authTimeoutMs); timer.unref();
    ws.on("error", () => {});
    ws.on("close", () => { clearTimeout(timer); ws.authorization = null; ws.user = null; });
    ws.on("pong", () => { ws.alive = true; });
    ws.on("message", async (raw, binary) => {
      try {
        if (binary || authenticating || ws.user) { ws.close(4000, "Unexpected message"); return; }
        authenticating = true;
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "authenticate" || Object.keys(frame).length !== 2 || typeof frame.token !== "string" || frame.token.length > 4096) throw new Error("Invalid auth frame");
        ws.authorization = `Bearer ${frame.token}`;
        const user = await auth.authenticate(ws.authorization);
        // No awaits between counting and assignment: concurrent handshakes share the limit.
        if ([...wss.clients].filter((other) => other.user?.user_id === user.user_id).length >= maxConnectionsPerUser) { ws.close(4008, "Connection limit"); return; }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.user = user; clearTimeout(timer);
        send(ws, { type: "authenticated", connection_id: randomUUID(), snapshot_required: true });
      } catch { ws.close(4001, "Authentication failed"); }
      finally { authenticating = false; }
    });
  });
  const monitor = startJob("realtime-monitor", async () => {
    await listen();
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (ws.user) await validate(ws);
    }
  }, { intervalMs: checkIntervalMs, logger });
  return {
    ready: () => listening,
    stop() { return stopping ??= (async () => {
      stopped = true; server.off("upgrade", upgrade); closeAll(); await monitor.stop(); await queue;
      if (client) { const connection = client; client = null; listening = false; try { await connection.query(`UNLISTEN "${channel}"`); } finally { connection.release(); } }
      await new Promise((resolve) => wss.close(resolve));
    })(); },
  };
}
