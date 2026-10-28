import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import { AppError } from "../common/errors.js";
export const topicPattern = /^smartclassroom\/room\/([A-Za-z0-9_-]{1,40})\/device\/([A-Za-z0-9_-]{1,40})\/(telemetry|heartbeat|status|ack|reported|config\/ack)$/;

export class MqttRuntime extends EventEmitter {
  constructor({ config, pool, logger, clean = false }) {
    super(); this.config = config; this.pool = pool; this.logger = logger; this.ready = false;
    this.client = mqtt.connect(config.mqttUrl, { username: config.mqttUsername, password: config.mqttPassword, clientId: config.mqttClientId, clean, reconnectPeriod: 1000, connectTimeout: 3000, queueQoSZero: false, protocolVersion: 4 });
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
    // Further business handlers are registered by BE-08 onwards; return their promises to avoid detached failures.
    for (const handler of this.listeners("device-message")) await handler(envelope);
  }
  async publish(topic, payload) {
    if (!this.ready || !this.client.connected) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa sẵn sàng");
    await this.client.publishAsync(topic, JSON.stringify(payload), { qos: 1, retain: false });
  }
  async stop() { this.ready = false; await this.client.endAsync(true); }
}
