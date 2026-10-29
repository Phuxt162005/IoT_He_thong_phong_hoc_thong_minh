import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, requireFound } from "../../common/errors.js";
import { lockActor } from "../../common/authorization.js";
import { parse } from "../../common/validation.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent, recordConnectionChange } from "../../database/events.js";
import { requireDeviceScope } from "../devices/devices.service.js";
import { finishConfig } from "./device-config.state.js";

export const settingsSchema = z.object({ sample_interval_seconds: z.number().int().min(1).max(300).optional(), heartbeat_interval_seconds: z.number().int().min(1).max(60).optional() }).strict().refine((v) => Object.keys(v).length > 0);
const ackSchema = z.object({ config_id: z.uuid(), device_id: z.string(), room_id: z.string(), session_id: z.string().min(1).max(64), version: z.number().int().positive().max(2147483647), status: z.enum(["SUCCESS", "FAILED"]), timestamp: z.number().int().min(0).max(8640000000000000), applied_settings: settingsSchema.optional(), error_code: z.string().regex(/^[A-Z0-9_]{1,40}$/).optional() }).strict();
const view = ({ config_id, device_id, version, settings, status, created_at, timeout_at, published_at, acknowledged_at, late_ack_at, error_code }) => ({ config_id, device_id, version, settings, status, created_at, timeout_at, published_at, acknowledged_at, late_ack_at, error_code });

export class DeviceConfigService {
  constructor({ pool, mqtt, heartbeatTimeoutSeconds = 30, timeoutSeconds = 10 }) { this.pool = pool; this.mqtt = mqtt; this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds; this.timeoutSeconds = timeoutSeconds; }
  async ready(client, device) {
    if (!this.mqtt.ready) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa sẵn sàng");
    if (!["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"].includes(device.lifecycle_status) || device.connection_status !== "ONLINE" || !device.session_id || !device.last_heartbeat_at || Date.now() - device.last_heartbeat_at.getTime() > this.heartbeatTimeoutSeconds * 1000) throw new AppError("DEVICE_NOT_READY", 409, "Thiết bị chưa sẵn sàng nhận cấu hình");
    const room = (await client.query("SELECT * FROM rooms WHERE room_id=$1", [device.room_id])).rows[0];
    const credential = (await client.query("SELECT version FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id])).rows[0];
    if (!room || room.status !== "ACTIVE" || !credential || device.broker_sync_status !== "SYNCED") throw new AppError("DEVICE_NOT_READY", 409, "Phòng hoặc credential chưa sẵn sàng");
    return { room, credential };
  }
  async create(actor, id, patch, requestId) {
    patch = parse(settingsSchema, patch);
    const queued = await withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "configs:write");
      await requireDeviceScope(client, actor, id);
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      const { credential } = await this.ready(client, device);
      if (device.device_type !== "SENSOR_NODE" && "sample_interval_seconds" in patch) throw new AppError("UNSUPPORTED_SETTING", 400, "Control Node không có chu kỳ lấy mẫu");
      const current = requireFound((await client.query("SELECT * FROM device_settings WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      // Ghép patch thành cấu hình đầy đủ rồi tăng version; desired chưa có nghĩa thiết bị đã áp dụng.
      const settings = { ...current.desired_settings, ...patch };
      // Chừa ít nhất ba chu kỳ heartbeat trong cửa sổ timeout để tránh cấu hình gây OFFLINE giả.
      if (settings.heartbeat_interval_seconds * 3 > this.heartbeatTimeoutSeconds) throw new AppError("UNSAFE_HEARTBEAT_INTERVAL", 400, "Chu kỳ heartbeat phải không quá một phần ba timeout backend");
      const version = current.desired_version + 1;
      const config = (await client.query(`INSERT INTO device_configs(config_id,device_id,room_id,version,settings,session_id,credential_version,requested_by,requested_token_version,timeout_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+($10::double precision * interval '1 second')) RETURNING *`, [randomUUID(), id, device.room_id, version, settings, device.session_id, credential.version, actor.user_id, actor.token_version, this.timeoutSeconds])).rows[0];
      await client.query("UPDATE device_settings SET desired_version=$1,desired_settings=$2,last_error_code=NULL,updated_at=now() WHERE device_id=$3", [version, settings, id]);
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "CONFIG_CREATE", targetType: "CONFIG", targetId: config.config_id, requestId, details: { device_id: id, version, settings } });
      await enqueueIotEvent(client, "config.updated", { config_id: config.config_id, device_id: id, room_id: device.room_id, status: "PENDING", version });
      return config;
    });
    // Lưu trước, gửi sau: restart vẫn tìm được cấu hình chưa publish và dùng lại config_id.
    const config = await this.publishOne(queued.config_id);
    if (config.error_code === "PUBLISH_ERROR") throw new AppError("MQTT_PUBLISH_FAILED", 503, "Không gửi được cấu hình MQTT", { config_id: config.config_id });
    return view(config);
  }
  async publishOne(id) {
    const initial = requireFound((await this.pool.query("SELECT * FROM device_configs WHERE config_id=$1", [id])).rows[0]);
    return withTransaction(this.pool, async (client) => {
      let authorized = true;
      try { await lockActor(client, { user_id: initial.requested_by, token_version: initial.requested_token_version }, "configs:write"); }
      catch (error) { if (!(error instanceof AppError)) throw error; authorized = false; }
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [initial.device_id])).rows[0]);
      const config = requireFound((await client.query("SELECT * FROM device_configs WHERE config_id=$1 FOR UPDATE", [id])).rows[0]);
      if (config.status !== "PENDING" || config.published_at) return config;
      if (config.timeout_at <= new Date()) return finishConfig(client, config, "TIMEOUT", "CONFIG_TIMEOUT");
      if (!authorized) return finishConfig(client, config, "FAILED", "PERMISSION_REVOKED");
      let target;
      try {
        target = await this.ready(client, device);
        if (config.session_id !== device.session_id || config.credential_version !== target.credential.version) throw new AppError("DEVICE_NOT_READY", 409, "Phiên thiết bị đã đổi");
      } catch (error) { if (!(error instanceof AppError)) throw error; return finishConfig(client, config, "FAILED", error.code === "BROKER_UNAVAILABLE" ? "PUBLISH_ERROR" : "DEVICE_NOT_READY"); }
      let timer;
      try {
        await Promise.race([this.mqtt.publish(`smartclassroom/room/${target.room.room_code}/device/${device.device_code}/config`, {
          config_id: config.config_id, device_id: device.device_code, room_id: target.room.room_code, session_id: config.session_id,
          version: config.version, settings: config.settings, timestamp: config.created_at.getTime(), expires_at: config.timeout_at.getTime(),
        }), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("PUBLISH_TIMEOUT")), 2000); })]);
      } catch { return finishConfig(client, config, "FAILED", "PUBLISH_ERROR"); }
      finally { clearTimeout(timer); }
      return (await client.query("UPDATE device_configs SET published_at=now() WHERE config_id=$1 RETURNING *", [id])).rows[0];
    });
  }
  async processPending() {
    const ids = (await this.pool.query("SELECT config_id FROM device_configs WHERE status='PENDING' AND published_at IS NULL ORDER BY created_at LIMIT 5")).rows;
    let count = 0;
    for (const row of ids) { const result = await this.publishOne(row.config_id); count++; if (result.error_code === "PUBLISH_ERROR") break; }
    return count;
  }
  async expirePending() {
    const ids = (await this.pool.query("SELECT config_id,device_id FROM device_configs WHERE status='PENDING' AND timeout_at<clock_timestamp() ORDER BY timeout_at LIMIT 100")).rows;
    let count = 0;
    for (const row of ids) await withTransaction(this.pool, async (client) => {
      await client.query("SELECT device_id FROM devices WHERE device_id=$1 FOR UPDATE", [row.device_id]);
      const config = (await client.query("SELECT * FROM device_configs WHERE config_id=$1 FOR UPDATE", [row.config_id])).rows[0];
      if (config?.status === "PENDING" && config.timeout_at < new Date()) { await finishConfig(client, config, "TIMEOUT", "CONFIG_TIMEOUT"); count++; }
    });
    return count;
  }
  async list(user, id, { page, page_size }) {
    await requireDeviceScope(this.pool, user, id);
    const state = (await this.pool.query("SELECT * FROM device_settings WHERE device_id=$1", [id])).rows[0];
    const total = Number((await this.pool.query("SELECT count(*) FROM device_configs WHERE device_id=$1", [id])).rows[0].count);
    const history = (await this.pool.query("SELECT * FROM device_configs WHERE device_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3", [id, page_size, (page - 1) * page_size])).rows.map(view);
    return { data: { state, history }, meta: { page, page_size, total } };
  }
  async handle(envelope) {
    if (envelope.kind !== "config/ack") return;
    const data = parse(ackSchema, envelope.payload);
    if (data.device_id !== envelope.deviceCode || data.room_id !== envelope.roomCode) throw new AppError("CONFIG_ACK_MISMATCH", 400, "Định danh cấu hình không khớp topic");
    return withTransaction(this.pool, async (client) => {
      const device = (await client.query(`SELECT d.* FROM devices d JOIN rooms r ON r.room_id=d.room_id WHERE d.device_code=$1 AND r.room_code=$2 FOR UPDATE OF d`, [envelope.deviceCode, envelope.roomCode])).rows[0];
      if (!device || !["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"].includes(device.lifecycle_status) || device.broker_sync_status !== "SYNCED" || device.session_id !== data.session_id) throw new AppError("CONFIG_ACK_MISMATCH", 400, "Phiên cấu hình không hợp lệ");
      if (!(await client.query("SELECT session_id FROM device_sessions WHERE device_id=$1 AND session_id=$2 AND closed_at IS NULL", [device.device_id, data.session_id])).rowCount) throw new AppError("CONFIG_ACK_MISMATCH", 400, "Phiên cấu hình đã đóng");
      const credential = (await client.query("SELECT version FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id])).rows[0];
      const config = (await client.query("SELECT * FROM device_configs WHERE config_id=$1 FOR UPDATE", [data.config_id])).rows[0];
      if (!credential || !config || config.device_id !== device.device_id || config.version !== data.version || config.session_id !== data.session_id || config.credential_version !== credential.version || data.timestamp > Date.now() + 300000) throw new AppError("CONFIG_ACK_MISMATCH", 400, "ACK không khớp cấu hình");
      if (data.applied_settings && !Object.entries(config.settings).every(([key, value]) => data.applied_settings[key] === value)) throw new AppError("CONFIG_APPLIED_MISMATCH", 400, "Cấu hình đã áp dụng không khớp yêu cầu");
      let current = config;
      if (current.status === "PENDING" && current.timeout_at <= new Date()) current = await finishConfig(client, current, "TIMEOUT", "CONFIG_TIMEOUT");
      const late = ["TIMEOUT", "FAILED"].includes(current.status) && current.acknowledged_at === null && current.late_ack_at === null;
      if (current.status !== "PENDING" && !late) return { duplicate: true };
      // Chỉ ACK SUCCESS mới xác nhận applied; version cũ không được ghi đè cấu hình mới hơn.
      // ACK muộn vẫn phản ánh thực tế thiết bị nhưng không sửa kết quả TIMEOUT/FAILED đã chốt.
      if (data.status === "SUCCESS") {
        await client.query("UPDATE device_settings SET applied_version=$1,applied_settings=$2,last_applied_at=now(),updated_at=now() WHERE device_id=$3 AND applied_version<$1", [config.version, config.settings, device.device_id]);
      }
      if (late) await client.query("UPDATE device_configs SET late_ack_at=now() WHERE config_id=$1", [config.config_id]);
      else {
        await finishConfig(client, current, data.status, data.status === "FAILED" ? (data.error_code ?? "CONFIG_ERROR") : null);
        await client.query("UPDATE device_configs SET acknowledged_at=now() WHERE config_id=$1", [config.config_id]);
      }
      await writeAudit(client, { actorType: "DEVICE", actorId: device.device_id, action: late ? "CONFIG_ACK_LATE" : "CONFIG_ACK", targetType: "CONFIG", targetId: config.config_id, details: { version: config.version, status: data.status } });
      await client.query("UPDATE devices SET connection_status='ONLINE',last_seen=now(),updated_at=now() WHERE device_id=$1", [device.device_id]);
      await recordConnectionChange(client, device, "ONLINE", "CONFIG_ACK");
      if (late) await enqueueIotEvent(client, "config.updated", { config_id: config.config_id, device_id: device.device_id, room_id: config.room_id, status: current.status, late_ack: true });
      return { duplicate: false, late };
    });
  }
}

export function bindDeviceConfig(runtime, configs) {
  const handler = (envelope) => configs.handle(envelope);
  runtime.on("device-message", handler);
  return () => runtime.off("device-message", handler);
}
