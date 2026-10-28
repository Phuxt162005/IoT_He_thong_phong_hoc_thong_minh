import { AppError, requireFound } from "../../common/errors.js";
import { lockActor } from "../../common/authorization.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { recordLifecycle, transitionDevice } from "./device-lifecycle.js";

export const deviceSelect = `SELECT d.device_id,d.device_code,d.device_name,d.device_type,d.room_id,d.lifecycle_status,d.connection_status,d.broker_sync_status,d.hardware_version,d.firmware_version,d.last_seen,d.last_heartbeat_at,d.last_rssi_dbm,d.last_free_heap_bytes,d.last_uptime_seconds,d.created_at,d.updated_at,r.room_code,r.status AS room_status FROM devices d LEFT JOIN rooms r ON r.room_id=d.room_id`;
const scopeSql = "($1::boolean OR EXISTS(SELECT 1 FROM user_rooms ur WHERE ur.room_id=d.room_id AND ur.user_id=$2))";
export async function requireDeviceScope(client, user, id) {
  return requireFound((await client.query(`${deviceSelect} WHERE ${scopeSql} AND d.device_id=$3`, [user.role === "ADMIN", user.user_id, id])).rows[0], "Không tìm thấy thiết bị trong phạm vi truy cập");
}

export class DevicesService {
  constructor(pool, { heartbeatTimeoutSeconds = 30 } = {}) { this.pool = pool; this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds; }
  async list(user, { page, page_size, room_id, lifecycle_status, device_type, connection_status }) {
    const where = `WHERE ${scopeSql} AND ($3::bigint IS NULL OR d.room_id=$3) AND ($4::text IS NULL OR d.lifecycle_status=$4) AND ($5::text IS NULL OR d.device_type=$5) AND ($6::text IS NULL OR d.connection_status=$6)`;
    const params = [user.role === "ADMIN", user.user_id, room_id ?? null, lifecycle_status ?? null, device_type ?? null, connection_status ?? null];
    const count = await this.pool.query(`SELECT count(*) FROM devices d ${where}`, params);
    const result = await this.pool.query(`${deviceSelect} ${where} ORDER BY d.device_id LIMIT $7 OFFSET $8`, [...params, page_size, (page - 1) * page_size]);
    return { data: result.rows, meta: { page, page_size, total: Number(count.rows[0].count) } };
  }
  async get(user, id) {
    const device = await requireDeviceScope(this.pool, user, id);
    const actuators = (await this.pool.query("SELECT actuator_id,actuator_type,desired_state,current_state,updated_at FROM actuators WHERE device_id=$1 ORDER BY actuator_id", [id])).rows;
    return { ...device, actuators };
  }
  async validateRoom(client, id) {
    if (id == null) return;
    const room = requireFound((await client.query("SELECT * FROM rooms WHERE room_id=$1 FOR SHARE", [id])).rows[0]);
    if (room.status !== "ACTIVE") throw new AppError("ROOM_INACTIVE", 409, "Phòng đã ngừng sử dụng");
  }
  async register(actor, input, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      await this.validateRoom(client, input.room_id);
      const device = (await client.query(`INSERT INTO devices(device_code,device_name,device_type,room_id,hardware_version,firmware_version)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.device_code, input.device_name, input.device_type, input.room_id ?? null, input.hardware_version ?? null, input.firmware_version ?? null])).rows[0];
      if (device.device_type === "CONTROL_NODE") {
        await client.query("INSERT INTO actuators(device_id,actuator_type) VALUES($1,'LIGHT'),($1,'FAN')", [device.device_id]);
        await client.query("INSERT INTO device_shadows(device_id) VALUES($1)", [device.device_id]);
      }
      await client.query("INSERT INTO device_settings(device_id,desired_settings) VALUES($1,$2)", [device.device_id, device.device_type === "SENSOR_NODE" ? { sample_interval_seconds: 5, heartbeat_interval_seconds: 10 } : { heartbeat_interval_seconds: 10 }]);
      await recordLifecycle(client, device, null, "REGISTERED", { actorId: actor.user_id, reason: "Đăng ký thiết bị", requestId, action: "DEVICE_REGISTER" });
      return (await client.query(`${deviceSelect} WHERE d.device_id=$1`, [device.device_id])).rows[0];
    });
  }
  async update(actor, id, patch, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      if (device.lifecycle_status === "DECOMMISSIONED") throw new AppError("DEVICE_RETIRED", 409, "Thiết bị đã ngừng sử dụng vĩnh viễn");
      if ("room_id" in patch && device.lifecycle_status !== "REGISTERED") throw new AppError("DEVICE_ALREADY_PROVISIONED", 409, "Chỉ gán lại phòng trước khi provision");
      const roomId = "room_id" in patch ? patch.room_id : device.room_id;
      await this.validateRoom(client, roomId);
      await client.query(`UPDATE devices SET device_name=$1,room_id=$2,hardware_version=$3,firmware_version=$4,updated_at=now() WHERE device_id=$5`, [patch.device_name ?? device.device_name, roomId, patch.hardware_version ?? device.hardware_version, patch.firmware_version ?? device.firmware_version, id]);
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "DEVICE_UPDATE", targetType: "DEVICE", targetId: id, requestId, details: { fields: Object.keys(patch), room_id: roomId } });
      return (await client.query(`${deviceSelect} WHERE d.device_id=$1`, [id])).rows[0];
    });
  }
  async lifecycle(actor, id, action, { reason, confirmed }, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      let to;
      if (action === "maintenance") to = "MAINTENANCE";
      if (["resume", "clear-fault", "recover"].includes(action)) {
        const expected = action === "resume" ? ["MAINTENANCE"] : action === "clear-fault" ? ["FAULT"] : ["FAULT", "MAINTENANCE"];
        if (!expected.includes(device.lifecycle_status)) throw new AppError("INVALID_DEVICE_TRANSITION", 409, "Thiết bị không ở trạng thái cần khôi phục");
        if (device.connection_status !== "ONLINE" || !device.last_heartbeat_at || Date.now() - device.last_heartbeat_at.getTime() > this.heartbeatTimeoutSeconds * 1000) throw new AppError("DEVICE_OFFLINE", 409, "Cần heartbeat mới để khôi phục thiết bị");
        await this.validateRoom(client, device.room_id);
        to = "ACTIVE";
      }
      if (action === "decommission") {
        if (!confirmed) throw new AppError("CONFIRMATION_REQUIRED", 400, "Cần xác nhận ngừng sử dụng vĩnh viễn");
        to = "DECOMMISSIONED";
      }
      if (!to) throw new AppError("INVALID_DEVICE_ACTION", 400, "Thao tác không được hỗ trợ");
      const result = await transitionDevice(client, device, to, { actorId: actor.user_id, reason, requestId, action: `DEVICE_${action.toUpperCase().replaceAll("-", "_")}` });
      if (to === "ACTIVE") await client.query("UPDATE devices SET fault_counters='{}' WHERE device_id=$1", [id]);
      return result;
    });
  }
  async events(user, id, { page, page_size }) {
    await requireDeviceScope(this.pool, user, id);
    const total = (await this.pool.query("SELECT count(*) FROM device_lifecycle_events WHERE device_id=$1", [id])).rows[0].count;
    const data = (await this.pool.query("SELECT * FROM device_lifecycle_events WHERE device_id=$1 ORDER BY event_id DESC LIMIT $2 OFFSET $3", [id, page_size, (page - 1) * page_size])).rows;
    return { data, meta: { page, page_size, total: Number(total) } };
  }
}
