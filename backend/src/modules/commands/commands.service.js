import { randomUUID, createHash } from "node:crypto";
import { AppError, requireFound } from "../../common/errors.js";
import { parse } from "../../common/validation.js";
import { lockActor } from "../../common/authorization.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent, recordConnectionChange } from "../../database/events.js";
import { DeviceShadowService, validateStatePatch } from "../device-shadow/device-shadow.service.js";
import { PostgresDeviceShadowRepository } from "../device-shadow/device-shadow.repository.pg.js";
import { requireDeviceScope } from "../devices/devices.service.js";
import { transitionDevice } from "../devices/device-lifecycle.js";
import { applyReportedState, finishCommand } from "./command-state.js";
import { ackSchema, reportedSchema } from "./command-schemas.js";

export function publicCommand(command) {
  const { command_id, device_id, room_id, desired_state, shadow_version, source, requested_by, rule_id, status, created_at, published_at, timeout_at, acked_at, late_ack_at, error_code } = command;
  return { command_id, device_id, room_id, desired_state, shadow_version, source, requested_by, rule_id, status, created_at, published_at, timeout_at, acked_at, late_ack_at, error_code };
}
function desiredPatch(value) {
  try { return validateStatePatch(value); }
  catch (error) { throw new AppError(error.code, 400, error.message); }
}

export class CommandsService {
  constructor({ pool, mqtt, logger, timeoutSeconds = 5, heartbeatTimeoutSeconds = 30, manualOverrideSeconds = 300 }) {
    this.pool = pool; this.mqtt = mqtt; this.logger = logger; this.timeoutSeconds = timeoutSeconds;
    this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds; this.manualOverrideSeconds = manualOverrideSeconds;
    this.shadow = new DeviceShadowService({ repository: new PostgresDeviceShadowRepository(pool), mqttPublisher: { publishCommand: (topic, payload) => mqtt.publish(topic, payload) } });
  }
  async assertReady(client, device) {
    if (!this.mqtt.ready) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa sẵn sàng");
    if (device.device_type !== "CONTROL_NODE" || device.lifecycle_status !== "ACTIVE") throw new AppError("DEVICE_NOT_CONTROLLABLE", 409, "Thiết bị không sẵn sàng điều khiển");
    if (device.connection_status !== "ONLINE" || !device.session_id || !device.last_heartbeat_at || Date.now() - device.last_heartbeat_at.getTime() > this.heartbeatTimeoutSeconds * 1000) throw new AppError("DEVICE_OFFLINE", 409, "Thiết bị chưa có heartbeat mới");
    const room = (await client.query("SELECT * FROM rooms WHERE room_id=$1", [device.room_id])).rows[0];
    if (!room || room.status !== "ACTIVE") throw new AppError("ROOM_INACTIVE", 409, "Phòng đã ngừng sử dụng");
    const credential = (await client.query("SELECT * FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id])).rows[0];
    if (!credential || device.broker_sync_status !== "SYNCED") throw new AppError("CREDENTIAL_NOT_READY", 409, "Credential chưa sẵn sàng");
    return { room, credential };
  }
  async enqueue(client, device, patch, { actor = null, ruleId = null, requestId = null, timeoutSeconds = this.timeoutSeconds } = {}) {
    const { room, credential } = await this.assertReady(client, device);
    if (!actor && (device.control_mode === "MANUAL" || device.manual_override_until > new Date())) throw new AppError("MANUAL_OVERRIDE", 409, "Thiết bị đang ưu tiên điều khiển thủ công");
    const shadow = requireFound((await client.query("SELECT * FROM device_shadows WHERE device_id=$1 FOR UPDATE", [device.device_id])).rows[0]);
    const version = shadow.desired_version + 1;
    const commandId = randomUUID();
    const command = (await client.query(`INSERT INTO commands(command_id,device_id,room_id,desired_state,shadow_version,session_id,credential_version,source,requested_by,requested_token_version,rule_id,request_id,timeout_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+($13::double precision * interval '1 second')) RETURNING *`,
      [commandId, device.device_id, room.room_id, patch, version, device.session_id, credential.version, actor ? "MANUAL" : "AUTOMATION", actor?.user_id ?? null, actor?.token_version ?? null, ruleId, requestId, timeoutSeconds])).rows[0];
    await client.query("UPDATE device_shadows SET desired_state=desired_state || $1::jsonb,desired_version=$2,last_command_error=NULL,updated_at=now() WHERE device_id=$3", [patch, version, device.device_id]);
    for (const [name, state] of Object.entries(patch)) await client.query("UPDATE actuators SET desired_state=$1,desired_version=$2,updated_at=now() WHERE device_id=$3 AND actuator_type=$4", [state, version, device.device_id, name.toUpperCase()]);
    if (actor) await client.query("UPDATE devices SET manual_override_until=clock_timestamp()+($1::double precision * interval '1 second') WHERE device_id=$2", [this.manualOverrideSeconds, device.device_id]);
    await writeAudit(client, { actorType: actor ? "USER" : "SYSTEM", actorId: actor?.user_id ?? null, action: "COMMAND_CREATE", targetType: "COMMAND", targetId: commandId, requestId, details: { device_id: device.device_id, source: command.source, desired_state: patch, rule_id: ruleId } });
    await enqueueIotEvent(client, "command.updated", { command_id: commandId, device_id: device.device_id, room_id: device.room_id, status: "PENDING" });
    return command;
  }
  async createManual(actor, id, input, { idempotencyKey, requestId } = {}) {
    const patch = desiredPatch(input.desired_state);
    const timeoutSeconds = input.timeout_seconds ?? this.timeoutSeconds;
    const payloadHash = createHash("sha256").update(JSON.stringify({ patch: Object.fromEntries(Object.entries(patch).sort()), timeoutSeconds })).digest("hex");
    const queued = await withTransaction(this.pool, async (client) => {
      const current = await lockActor(client, actor, "commands:create");
      await requireDeviceScope(client, current, id);
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      if (idempotencyKey) {
        const existing = (await client.query("SELECT * FROM command_idempotency WHERE user_id=$1 AND device_id=$2 AND key=$3 AND expires_at>now()", [actor.user_id, id, idempotencyKey])).rows[0];
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Khóa idempotency đã dùng với nội dung khác");
          return { command: (await client.query("SELECT * FROM commands WHERE command_id=$1", [existing.command_id])).rows[0], cached: true };
        }
      }
      const command = await this.enqueue(client, device, patch, { actor: current, requestId, timeoutSeconds });
      if (idempotencyKey) {
        await client.query(`INSERT INTO command_idempotency(user_id,device_id,key,payload_hash,command_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds')
          ON CONFLICT(user_id,device_id,key) DO UPDATE SET payload_hash=EXCLUDED.payload_hash,command_id=EXCLUDED.command_id,expires_at=EXCLUDED.expires_at`, [actor.user_id, id, idempotencyKey, payloadHash, command.command_id]);
      }
      return { command, cached: false };
    });
    const command = queued.cached ? queued.command : await this.publishOne(queued.command.command_id);
    if (!queued.cached && command?.error_code === "PUBLISH_ERROR") throw new AppError("MQTT_PUBLISH_FAILED", 503, "Không gửi được lệnh MQTT", { command_id: queued.command.command_id });
    return { command: publicCommand(command), cached: queued.cached, shadow: await this.getShadow(actor, id) };
  }
  async enqueueSystem(client, id, state, ruleId) {
    const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
    return this.enqueue(client, device, desiredPatch(state), { ruleId });
  }
  async publishOne(commandId) {
    const initial = requireFound((await this.pool.query("SELECT * FROM commands WHERE command_id=$1", [commandId])).rows[0]);
    return withTransaction(this.pool, async (client) => {
      let permissionError = false;
      if (initial.source === "MANUAL") {
        try {
          const actor = await lockActor(client, { user_id: initial.requested_by, token_version: initial.requested_token_version }, "commands:create");
          await requireDeviceScope(client, actor, initial.device_id);
        } catch (error) { if (!(error instanceof AppError)) throw error; permissionError = true; }
      }
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [initial.device_id])).rows[0]);
      const command = requireFound((await client.query("SELECT * FROM commands WHERE command_id=$1 FOR UPDATE", [commandId])).rows[0]);
      if (command.status !== "PENDING" || command.published_at) return command;
      if (command.timeout_at <= new Date()) return finishCommand(client, command, "TIMEOUT", "ACK_TIMEOUT");
      if (permissionError) return finishCommand(client, command, "FAILED", "PERMISSION_REVOKED");
      let context;
      try {
        context = await this.assertReady(client, device);
        if (device.session_id !== command.session_id || context.credential.version !== command.credential_version) throw new AppError("DEVICE_SESSION_MISMATCH", 409, "Phiên thiết bị đã thay đổi");
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return finishCommand(client, command, "FAILED", error.code === "BROKER_UNAVAILABLE" ? "PUBLISH_ERROR" : "DEVICE_NOT_READY");
      }
      let timer;
      try {
        await Promise.race([
          this.mqtt.publish(`smartclassroom/room/${context.room.room_code}/device/${device.device_code}/command`, {
            command_id: command.command_id, device_id: device.device_code, room_id: context.room.room_code,
            session_id: command.session_id, shadow_version: command.shadow_version, desired_state: command.desired_state,
            timestamp: command.created_at.getTime(), expires_at: command.timeout_at.getTime(),
          }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("PUBLISH_TIMEOUT")), 2000); }),
        ]);
      } catch {
        return finishCommand(client, command, "FAILED", "PUBLISH_ERROR");
      } finally { clearTimeout(timer); }
      const sent = (await client.query("UPDATE commands SET published_at=now() WHERE command_id=$1 AND status='PENDING' RETURNING *", [commandId])).rows[0];
      await enqueueIotEvent(client, "command.updated", { command_id: commandId, device_id: device.device_id, room_id: device.room_id, status: "PENDING", published: true });
      return sent;
    });
  }
  async processPending() {
    const rows = (await this.pool.query("SELECT command_id FROM commands WHERE status='PENDING' AND published_at IS NULL ORDER BY created_at LIMIT 5")).rows;
    let processed = 0;
    for (const row of rows) {
      const result = await this.publishOne(row.command_id);
      processed++;
      if (result?.error_code === "PUBLISH_ERROR") break;
    }
    return processed;
  }
  async expirePending() {
    const ids = (await this.pool.query("SELECT command_id FROM commands WHERE status='PENDING' AND timeout_at<clock_timestamp() ORDER BY timeout_at LIMIT 100")).rows;
    let count = 0;
    for (const { command_id } of ids) {
      await withTransaction(this.pool, async (client) => {
        const initial = (await client.query("SELECT device_id FROM commands WHERE command_id=$1", [command_id])).rows[0];
        if (!initial) return;
        await client.query("SELECT device_id FROM devices WHERE device_id=$1 FOR UPDATE", [initial.device_id]);
        const command = (await client.query("SELECT * FROM commands WHERE command_id=$1 FOR UPDATE", [command_id])).rows[0];
        if (command?.status === "PENDING" && command.timeout_at < new Date()) { await finishCommand(client, command, "TIMEOUT", "ACK_TIMEOUT"); count++; }
      });
    }
    return count;
  }
  async getShadow(user, id) {
    const device = await requireDeviceScope(this.pool, user, id);
    if (device.device_type !== "CONTROL_NODE") throw new AppError("NOT_CONTROL_NODE", 409, "Sensor Node không có Device Shadow điều khiển");
    const shadow = await this.shadow.getShadow(device.device_code);
    return { device_id: id, device_code: device.device_code, desired_state: shadow.desiredState, reported_state: shadow.reportedState,
      shadow_version: shadow.version, reported_version: shadow.reportedVersion, in_sync: shadow.inSync, differences: shadow.differences,
      last_reported_at: shadow.lastReportedAt, last_command_error: shadow.lastCommandError, latest_command: shadow.latestCommand };
  }
  async list(user, id, { page, page_size }) {
    await requireDeviceScope(this.pool, user, id);
    const total = (await this.pool.query("SELECT count(*) FROM commands WHERE device_id=$1", [id])).rows[0].count;
    const data = (await this.pool.query("SELECT * FROM commands WHERE device_id=$1 ORDER BY shadow_version DESC LIMIT $2 OFFSET $3", [id, page_size, (page - 1) * page_size])).rows.map(publicCommand);
    return { data, meta: { page, page_size, total: Number(total) } };
  }
  async replyDevice(client, envelope, data) {
    if (data.device_id !== envelope.deviceCode || data.room_id !== envelope.roomCode) throw new AppError("ACK_TOPIC_MISMATCH", 400, "Định danh phản hồi không khớp topic");
    const device = (await client.query(`SELECT d.* FROM devices d JOIN rooms r ON r.room_id=d.room_id WHERE d.device_code=$1 AND r.room_code=$2 FOR UPDATE OF d`, [envelope.deviceCode, envelope.roomCode])).rows[0];
    if (!device || device.device_type !== "CONTROL_NODE" || !["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"].includes(device.lifecycle_status) || device.broker_sync_status !== "SYNCED") throw new AppError("INVALID_ACK_DEVICE", 403, "Thiết bị không được phép phản hồi");
    const session = await client.query("SELECT session_id FROM device_sessions WHERE device_id=$1 AND session_id=$2 AND closed_at IS NULL", [device.device_id, data.session_id]);
    if (!session.rowCount || device.session_id !== data.session_id) throw new AppError("DEVICE_SESSION_MISMATCH", 409, "Phản hồi không thuộc phiên hiện tại");
    const credential = (await client.query("SELECT version FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id])).rows[0];
    if (!credential) throw new AppError("INVALID_ACK_DEVICE", 403, "Credential không hợp lệ");
    if (data.timestamp > Date.now() + 300000) throw new AppError("INVALID_ACK_TIME", 400, "Thời gian phản hồi không hợp lệ");
    return { device, credential };
  }
  async touchPresence(client, device) {
    await client.query("UPDATE devices SET connection_status='ONLINE',last_seen=now(),updated_at=now() WHERE device_id=$1", [device.device_id]);
    await recordConnectionChange(client, device, "ONLINE", "DEVICE_REPLY");
  }
  async handle(envelope) {
    const embedded = envelope.kind === "status" && envelope.payload?.status === "ONLINE" && envelope.payload.reported_state;
    if (!["ack", "reported"].includes(envelope.kind) && !embedded) return;
    try {
      let input = envelope.payload;
      if (embedded) {
        const { device_id, room_id, session_id, shadow_version, timestamp, reported_state } = input;
        input = { device_id, room_id, session_id, shadow_version, timestamp, reported_state };
      }
      const data = parse(envelope.kind === "ack" ? ackSchema : reportedSchema, input);
      return await withTransaction(this.pool, async (client) => {
        const { device, credential } = await this.replyDevice(client, envelope, data);
        if (envelope.kind !== "ack") {
          const changed = await applyReportedState(client, device, data);
          if (changed) await this.touchPresence(client, device);
          return changed;
        }
        let command = (await client.query("SELECT * FROM commands WHERE command_id=$1 FOR UPDATE", [data.command_id])).rows[0];
        if (!command || command.device_id !== device.device_id || command.shadow_version !== data.shadow_version || command.session_id !== data.session_id || command.credential_version !== credential.version) throw new AppError("ACK_COMMAND_MISMATCH", 400, "ACK không khớp lệnh, version hoặc phiên thiết bị");
        if (data.status === "SUCCESS" && !Object.entries(command.desired_state).every(([key, value]) => data.reported_state[key] === value)) throw new AppError("ACK_STATE_MISMATCH", 400, "ACK thành công không khớp trạng thái đã yêu cầu");
        if (command.status === "PENDING" && command.timeout_at <= new Date()) command = await finishCommand(client, command, "TIMEOUT", "ACK_TIMEOUT");
        if (command.status !== "PENDING") {
          let late = false;
          if (["TIMEOUT", "FAILED"].includes(command.status) && !command.ack_payload && !command.late_ack_at) {
            late = true;
            if (data.reported_state) await applyReportedState(client, device, data);
            await client.query("UPDATE commands SET late_ack_at=now(),ack_payload=$1 WHERE command_id=$2", [data, command.command_id]);
            await this.touchPresence(client, device);
            await writeAudit(client, { actorType: "DEVICE", actorId: device.device_id, action: "COMMAND_ACK_LATE", targetType: "COMMAND", targetId: command.command_id, details: { status: command.status } });
            await enqueueIotEvent(client, "command.updated", { command_id: command.command_id, device_id: device.device_id, room_id: device.room_id, status: command.status, late_ack: true });
          }
          return { status: command.status, duplicate: !late, late };
        }
        if (data.reported_state) await applyReportedState(client, device, data);
        const result = await finishCommand(client, command, data.status, data.status === "FAILED" ? (data.error_code ?? "DEVICE_ERROR") : null, { ackPayload: data });
        await this.touchPresence(client, device);
        const failed = data.status === "FAILED";
        const updated = (await client.query("UPDATE devices SET fault_counters=jsonb_set(fault_counters,'{relay_err}',to_jsonb(CASE WHEN $1::boolean THEN coalesce((fault_counters->>'relay_err')::integer,0)+1 ELSE 0 END)),last_seen=now(),updated_at=now() WHERE device_id=$2 RETURNING *", [failed, device.device_id])).rows[0];
        if (failed && updated.fault_counters.relay_err >= 3 && updated.lifecycle_status === "ACTIVE") await transitionDevice(client, updated, "FAULT", { actorType: "SYSTEM", reason: "Ba lần thực thi relay thất bại liên tiếp", action: "DEVICE_FAULT" });
        return { command: publicCommand(result), duplicate: false };
      });
    } catch (error) {
      if (error instanceof AppError) await writeAudit(this.pool, { actorType: "DEVICE", action: "COMMAND_REPLY_REJECTED", targetType: "DEVICE", targetId: envelope.deviceCode, result: "DENIED", details: { code: error.code } });
      throw error;
    }
  }
}

export function bindCommands(runtime, commands) {
  const handler = (envelope) => commands.handle(envelope);
  runtime.on("device-message", handler);
  return () => runtime.off("device-message", handler);
}
