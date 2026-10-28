import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import { z } from "zod";
import { AppError } from "../common/errors.js";
import { withTransaction } from "../database/pool.js";

const code = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const heartbeatSchema = z.object({ msg_id: z.string().min(1).max(64), device_id: code, room_id: code, session_id: z.string().min(1).max(64), timestamp: z.number().int().nonnegative(), uptime_seconds: z.number().int().nonnegative(), free_heap_bytes: z.number().int().nonnegative(), wifi_rssi_dbm: z.number().int().min(-127).max(0), firmware_version: z.string().min(1).max(64).optional() }).strict();
export const topicPattern = /^smartclassroom\/room\/([A-Za-z0-9_-]{1,40})\/device\/([A-Za-z0-9_-]{1,40})\/(telemetry|heartbeat|status|ack|reported|config\/ack)$/;

export class MqttRuntime extends EventEmitter {
  constructor({ config, pool, logger }) {
    super(); this.config = config; this.pool = pool; this.logger = logger; this.ready = false;
    this.client = mqtt.connect(config.mqttUrl, { username: config.mqttUsername, password: config.mqttPassword, clientId: config.mqttClientId, clean: false, reconnectPeriod: 1000, connectTimeout: 3000, queueQoSZero: false, protocolVersion: 4 });
    this.client.on("error", () => { this.ready = false; logger.warn("mqtt.connection_error"); });
    this.client.on("offline", () => { this.ready = false; });
    this.client.on("close", () => { this.ready = false; });
    this.client.on("reconnect", () => { this.client.options.reconnectPeriod = Math.min(30000, this.client.options.reconnectPeriod * 2); });
    this.client.on("connect", async () => {
      this.client.options.reconnectPeriod = 1000;
      try {
        const granted = await this.client.subscribeAsync(["telemetry", "heartbeat", "status", "ack", "reported", "config/ack"].map((suffix) => `smartclassroom/room/+/device/+/${suffix}`), { qos: 1 });
        this.ready = granted.every((g) => g.qos !== 128);
        if (this.ready) { logger.info("mqtt.connected"); this.emit("ready"); }
      } catch { this.ready = false; logger.warn("mqtt.subscribe_failed"); }
    });
    this.client.on("message", (topic, raw) => { void this.handleMessage(topic, raw).catch((error) => logger.warn("mqtt.message_rejected", { code: error.code ?? "INVALID_MESSAGE" })); });
  }
  async handleMessage(topic, raw) {
    const match = topicPattern.exec(topic);
    if (!match || raw.byteLength > 2048) throw new AppError("INVALID_MQTT_MESSAGE", 400, "Bản tin MQTT không hợp lệ");
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch { throw new AppError("INVALID_JSON", 400, "JSON không hợp lệ"); }
    const envelope = { topic, roomCode: match[1], deviceCode: match[2], kind: match[3], payload };
    if (envelope.kind === "heartbeat") await this.recordProvisionedHandshake(envelope);
    // Further business handlers are registered by BE-08 onwards; return their promises to avoid detached failures.
    for (const handler of this.listeners("device-message")) await handler(envelope);
  }
  async recordProvisionedHandshake({ roomCode, deviceCode, payload }) {
    const parsed = heartbeatSchema.safeParse(payload);
    if (!parsed.success || parsed.data.device_id !== deviceCode || parsed.data.room_id !== roomCode) throw new AppError("INVALID_HEARTBEAT", 400, "Heartbeat không hợp lệ hoặc không khớp topic");
    const data = parsed.data;
    await withTransaction(this.pool, async (client) => {
      const device = (await client.query(`SELECT d.* FROM devices d JOIN rooms r ON r.room_id=d.room_id
        WHERE d.device_code=$1 AND r.room_code=$2 AND r.status='ACTIVE' FOR UPDATE OF d`, [deviceCode, roomCode])).rows[0];
      if (!device || device.lifecycle_status !== "PROVISIONED" || device.broker_sync_status !== "SYNCED") return;
      const valid = await client.query("SELECT credential_id FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id]);
      if (!valid.rowCount) return;
      await client.query("UPDATE devices SET connection_status='ONLINE',last_seen=now(),session_id=$1,firmware_version=coalesce($2,firmware_version),updated_at=now() WHERE device_id=$3", [data.session_id, data.firmware_version ?? null, device.device_id]);
    });
  }
  async publish(topic, payload) {
    if (!this.ready || !this.client.connected) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa sẵn sàng");
    await this.client.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: false });
  }
  async stop() { this.ready = false; await this.client.endAsync(true); }
}
