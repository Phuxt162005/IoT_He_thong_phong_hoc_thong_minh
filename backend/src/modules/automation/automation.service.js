import { AppError, requireFound } from "../../common/errors.js";
import { lockActor, requireRoomScope } from "../../common/authorization.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent } from "../../database/events.js";
import { requireDeviceScope } from "../devices/devices.service.js";
import { cancelPendingDeviceCommands } from "../commands/command-state.js";
import { matches } from "./conditions.js";

export class AutomationService {
  constructor({ pool, commands, freshnessSeconds = 30, heartbeatTimeoutSeconds = 30 }) {
    this.pool = pool; this.commands = commands; this.freshnessSeconds = freshnessSeconds; this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds;
    if (commands) commands.automationGuard = (client, command, device) => this.guard(client, command, device);
  }
  async list(user, roomId, { page, page_size }) {
    await requireRoomScope(this.pool, user, roomId);
    const total = Number((await this.pool.query("SELECT count(*) FROM automation_rules WHERE room_id=$1", [roomId])).rows[0].count);
    const data = (await this.pool.query(`SELECT r.*,s.true_since,s.last_triggered_at FROM automation_rules r JOIN automation_rule_state s USING(rule_id)
      WHERE room_id=$1 ORDER BY priority,rule_id LIMIT $2 OFFSET $3`, [roomId, page_size, (page - 1) * page_size])).rows;
    return { data, meta: { page, page_size, total } };
  }
  async save(user, { roomId, ruleId, input, requestId }) {
    return withTransaction(this.pool, async (client) => {
      const actor = await lockActor(client, user, "rules:write");
      const existing = ruleId ? requireFound((await client.query("SELECT * FROM automation_rules WHERE rule_id=$1", [ruleId])).rows[0]) : null;
      roomId = existing?.room_id ?? roomId;
      await requireRoomScope(client, actor, roomId);
      await client.query("SELECT room_id FROM rooms WHERE room_id=$1 FOR UPDATE", [roomId]);
      const current = existing ? (await client.query("SELECT * FROM automation_rules WHERE rule_id=$1 FOR UPDATE", [ruleId])).rows[0] : {};
      const value = { ...current, ...input };
      const target = (await client.query("SELECT device_id FROM devices WHERE device_id=$1 AND room_id=$2 AND device_type='CONTROL_NODE'", [value.target_device_id, roomId])).rows[0];
      if (!target) throw new AppError("INVALID_RULE_TARGET", 400, "Rule phải điều khiển Control Node trong phòng");
      const params = [value.name, value.target_device_id, value.actuator, value.action, value.condition, value.hold_seconds, value.cooldown_seconds, value.priority, value.is_enabled];
      const rule = existing
        ? (await client.query(`UPDATE automation_rules SET name=$1,target_device_id=$2,actuator=$3,action=$4,condition=$5,hold_seconds=$6,cooldown_seconds=$7,priority=$8,is_enabled=$9,updated_at=now() WHERE rule_id=$10 RETURNING *`, [...params, ruleId])).rows[0]
        : (await client.query(`INSERT INTO automation_rules(name,target_device_id,actuator,action,condition,hold_seconds,cooldown_seconds,priority,is_enabled,room_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...params, roomId, actor.user_id])).rows[0];
      await client.query(`INSERT INTO automation_rule_state(rule_id) VALUES($1) ON CONFLICT(rule_id) DO UPDATE SET true_since=NULL,last_data_id=NULL,last_trigger_data_id=NULL`, [rule.rule_id]);
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: existing ? "RULE_UPDATE" : "RULE_CREATE", targetType: "RULE", targetId: rule.rule_id, requestId, details: { room_id: roomId, is_enabled: rule.is_enabled } });
      return rule;
    });
  }
  async setMode(user, id, { control_mode, reason }, requestId) {
    return withTransaction(this.pool, async (client) => {
      const actor = await lockActor(client, user, "commands:create");
      await requireDeviceScope(client, actor, id);
      const device = (await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0];
      if (device.device_type !== "CONTROL_NODE" || ["REVOKED", "DECOMMISSIONED"].includes(device.lifecycle_status)) throw new AppError("INVALID_CONTROL_MODE", 409, "Thiết bị không hỗ trợ thay đổi chế độ");
      if (control_mode === "MANUAL") await cancelPendingDeviceCommands(client, id, "MANUAL_MODE", "AUTOMATION");
      const updated = (await client.query("UPDATE devices SET control_mode=$1,manual_override_until=NULL,updated_at=now() WHERE device_id=$2 RETURNING device_id,control_mode,manual_override_until", [control_mode, id])).rows[0];
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "DEVICE_CONTROL_MODE", targetType: "DEVICE", targetId: id, requestId, details: { control_mode, reason } });
      await enqueueIotEvent(client, "device.mode_changed", { ...updated, room_id: device.room_id });
      return updated;
    });
  }
  // Chỉ lấy latest còn mới từ Sensor ACTIVE/ONLINE có heartbeat mới; loại mẫu bù/lệch đồng hồ.
  async sample(client, roomId) {
    return (await client.query(`SELECT s.* FROM telemetry_latest l JOIN sensor_data s ON s.data_id=l.data_id
      JOIN devices d ON d.device_id=s.device_id JOIN rooms r ON r.room_id=s.room_id JOIN iot_events e ON e.data_id=s.data_id
      WHERE s.room_id=$1 AND d.lifecycle_status='ACTIVE' AND d.connection_status='ONLINE' AND d.broker_sync_status='SYNCED'
      AND r.status='ACTIVE' AND e.event_type='telemetry.stored' AND e.payload->>'eligible'='true'
      AND d.last_heartbeat_at>=clock_timestamp()-($3::double precision * interval '1 second')
      AND s.recorded_at>=clock_timestamp()-($2::double precision * interval '1 second')
      ORDER BY s.recorded_at DESC,s.data_id DESC LIMIT 1`, [roomId, this.freshnessSeconds, this.heartbeatTimeoutSeconds])).rows[0];
  }
  // Kiểm tra lại rule và manual override trước khi publish, vì chúng có thể đổi sau lúc xếp lệnh.
  async guard(client, command, device) {
    if (device.control_mode === "MANUAL" || device.manual_override_until > new Date()) return false;
    const rule = (await client.query("SELECT * FROM automation_rules WHERE rule_id=$1 AND is_enabled AND target_device_id=$2", [command.rule_id, device.device_id])).rows[0];
    const sample = rule && await this.sample(client, rule.room_id);
    return !!sample && matches(rule.condition, sample) && command.desired_state[rule.actuator.toLowerCase()] === rule.action;
  }
  async tick() {
    const rooms = (await this.pool.query("SELECT DISTINCT room_id FROM automation_rules WHERE is_enabled ORDER BY room_id LIMIT 1000")).rows;
    let queued = 0;
    for (const { room_id } of rooms) queued += await withTransaction(this.pool, async (client) => {
      await client.query("SELECT room_id FROM rooms WHERE room_id=$1 FOR UPDATE", [room_id]);
      const rules = (await client.query(`SELECT r.*,s.true_since,s.last_evaluated_at,s.last_triggered_at,s.last_trigger_data_id FROM automation_rules r
        JOIN automation_rule_state s USING(rule_id) WHERE r.room_id=$1 AND r.is_enabled ORDER BY r.priority,r.rule_id FOR UPDATE OF s`, [room_id])).rows;
      const sample = await this.sample(client, room_id);
      const winners = new Set();
      let count = 0;
      for (const rule of rules) {
        const satisfied = !!sample && matches(rule.condition, sample);
        // Gián đoạn đánh giá quá cửa sổ freshness thì tính lại hold, không cộng thời gian thiếu dữ liệu.
        const continuous = rule.last_evaluated_at && Date.now() - rule.last_evaluated_at.getTime() <= this.freshnessSeconds * 1000;
        const since = satisfied ? (continuous ? rule.true_since : null) ?? new Date() : null;
        await client.query("UPDATE automation_rule_state SET true_since=$1,last_data_id=$2,last_evaluated_at=clock_timestamp() WHERE rule_id=$3", [since, sample?.data_id ?? null, rule.rule_id]);
        if (!satisfied || Date.now() - since.getTime() < rule.hold_seconds * 1000) continue;
        const key = `${rule.target_device_id}:${rule.actuator}`;
        if (winners.has(key)) continue;
        // Rule thắng vẫn giữ ưu tiên trong cooldown; không nhường cho rule đối nghịch bật/tắt liên tục.
        winners.add(key);
        // Ghi nhớ ID mẫu đã kích hoạt để tick/restart không tạo lệnh lần hai từ cùng dữ liệu.
        if (rule.last_trigger_data_id === sample.data_id || (rule.last_triggered_at && Date.now() - rule.last_triggered_at.getTime() < rule.cooldown_seconds * 1000)) continue;
        const device = (await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [rule.target_device_id])).rows[0];
        if (!device || device.control_mode === "MANUAL" || device.manual_override_until > new Date()) continue;
        try { await this.commands.assertReady(client, device); } catch (error) { if (error instanceof AppError) continue; throw error; }
        const actuator = (await client.query("SELECT * FROM actuators WHERE device_id=$1 AND actuator_type=$2", [device.device_id, rule.actuator])).rows[0];
        const pending = await client.query("SELECT command_id FROM commands WHERE device_id=$1 AND status='PENDING' AND desired_state ? $2", [device.device_id, rule.actuator.toLowerCase()]);
        if (pending.rowCount || (actuator.desired_state === rule.action && actuator.current_state === rule.action)) continue;
        await this.commands.enqueueSystem(client, device.device_id, { [rule.actuator.toLowerCase()]: rule.action }, rule.rule_id);
        await client.query("UPDATE automation_rule_state SET last_triggered_at=clock_timestamp(),last_trigger_data_id=$1 WHERE rule_id=$2", [sample.data_id, rule.rule_id]);
        count++;
      }
      return count;
    });
    return queued;
  }
}
