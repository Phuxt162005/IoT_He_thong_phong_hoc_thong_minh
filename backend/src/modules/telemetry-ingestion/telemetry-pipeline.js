import { EventEmitter } from "node:events";
import { AppError } from "../../common/errors.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { recordConnectionChange } from "../../database/events.js";
import { transitionDevice } from "../devices/device-lifecycle.js";
import { TelemetryIngestionService } from "./telemetry-ingestion.service.js";
import { PostgresTelemetryRepository } from "./telemetry-ingestion.repository.pg.js";
import { normalizeTelemetry } from "./telemetry-normalizer.js";

export class TelemetryPipeline {
  constructor({ pool, mqtt, logger, events = new EventEmitter({ captureRejections: true }), freshnessSeconds = 30 }) {
    this.pool = pool; this.mqtt = mqtt; this.logger = logger; this.events = events; this.freshnessSeconds = freshnessSeconds;
    events.on("error", () => logger.warn("telemetry.event_listener_failed"));
  }
  async recordRejection({ deviceCode, roomCode }, code, sensorInvalid = false) {
    await withTransaction(this.pool, async (client) => {
      let device = (await client.query("SELECT d.* FROM devices d JOIN rooms r ON r.room_id=d.room_id WHERE d.device_code=$1 AND r.room_code=$2 FOR UPDATE OF d", [deviceCode, roomCode])).rows[0];
      await writeAudit(client, { actorType: "DEVICE", actorId: device?.device_id ?? null, action: "MQTT_REJECTED", targetType: "DEVICE", targetId: device?.device_id ?? deviceCode, result: "DENIED", details: { code } });
      if (sensorInvalid && device?.lifecycle_status === "ACTIVE" && device.broker_sync_status === "SYNCED") {
        device = (await client.query("UPDATE devices SET fault_counters=jsonb_set(fault_counters,'{sensor_err}',to_jsonb(coalesce((fault_counters->>'sensor_err')::integer,0)+1)) WHERE device_id=$1 RETURNING *", [device.device_id])).rows[0];
        if (device.fault_counters.sensor_err >= 5) await transitionDevice(client, device, "FAULT", { actorType: "SYSTEM", reason: "Năm bản tin cảm biến không hợp lệ liên tiếp", action: "DEVICE_FAULT" });
      }
    });
  }
  async ingest(envelope) {
    let normalized;
    try { normalized = normalizeTelemetry(envelope.payload); }
    catch (error) { await this.recordRejection(envelope, "INVALID_TELEMETRY", true); throw error; }
    if (normalized.deviceId !== envelope.deviceCode || normalized.roomCode !== envelope.roomCode) {
      await this.recordRejection(envelope, "TOPIC_PAYLOAD_MISMATCH");
      throw new AppError("TOPIC_PAYLOAD_MISMATCH", 400, "Định danh không khớp topic");
    }
    let stored;
    try {
      stored = await withTransaction(this.pool, async (client) => {
        const device = (await client.query(`SELECT d.*,r.status AS room_status FROM devices d JOIN rooms r ON r.room_id=d.room_id
          WHERE d.device_code=$1 AND r.room_code=$2 FOR UPDATE OF d`, [envelope.deviceCode, envelope.roomCode])).rows[0];
        if (!device || !["ACTIVE", "FAULT", "MAINTENANCE"].includes(device.lifecycle_status) || device.room_status !== "ACTIVE" || device.broker_sync_status !== "SYNCED") throw new AppError("DEVICE_NOT_ACCEPTING_TELEMETRY", 403, "Thiết bị chưa được phép gửi dữ liệu");
        const credential = await client.query("SELECT credential_id FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id]);
        if (!credential.rowCount || device.device_type !== "SENSOR_NODE") throw new AppError("INVALID_SENSOR_IDENTITY", 403, "Không có định danh Sensor hợp lệ");
        const receivedAt = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
        // Mẫu đo cũ hợp lệ là dữ liệu bù sau mất mạng; giữ thời gian đo để tra cứu đúng lịch sử.
        // Chỉ thiếu thời gian hoặc vượt tương lai quá mức mới bị đánh dấu lệch đồng hồ.
        const clockSkew = normalized.timestampMs === null || normalized.timestampMs > receivedAt.getTime() + 5 * 60 * 1000;
        const recordedAt = clockSkew ? receivedAt : new Date(normalized.timestampMs);
        const repository = new PostgresTelemetryRepository(client, { device, normalized, receivedAt, recordedAt, clockSkew, freshnessSeconds: this.freshnessSeconds });
        const service = new TelemetryIngestionService({ repository, now: () => receivedAt.toISOString() });
        const result = await service.ingest({ ...normalized, timestamp: recordedAt.toISOString() });
        await client.query("UPDATE devices SET connection_status='ONLINE',last_seen=$1,updated_at=$1,fault_counters=jsonb_set(fault_counters,'{sensor_err}','0') WHERE device_id=$2", [receivedAt, device.device_id]);
        await recordConnectionChange(client, device, "ONLINE", "TELEMETRY");
        return { result, event: repository.createdEvent, receivedAt, legacy: normalized.legacy };
      });
    } catch (error) {
      if (error instanceof AppError) await this.recordRejection(envelope, error.code);
      throw error;
    }
    if (stored.event) {
      try { this.events.emit("telemetry.stored", stored.event); }
      catch { this.logger.warn("telemetry.event_listener_failed"); }
    }
    return stored;
  }
  async handle(envelope) {
    if (envelope.kind !== "telemetry") return;
    // ingest chỉ trả về sau commit. Nếu database lỗi, không gửi ACK STORED để bên gửi còn retry.
    const { result, receivedAt, legacy } = await this.ingest(envelope);
    const ack = legacy ? { messageType: "telemetry_ack", eventId: result.eventId, status: "STORED", duplicate: result.duplicate, timestamp: receivedAt.toISOString() }
      : { msg_id: result.eventId, device_id: envelope.deviceCode, room_id: envelope.roomCode, status: "STORED", duplicate: result.duplicate, timestamp: receivedAt.getTime() };
    await this.mqtt.publish(`${envelope.topic}/ack`, ack);
    return ack;
  }
}

export function bindTelemetry(runtime, pipeline) {
  const handler = (message) => pipeline.handle(message);
  runtime.on("device-message", handler);
  return () => runtime.off("device-message", handler);
}
