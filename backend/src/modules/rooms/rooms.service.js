import { AppError, requireFound } from "../../common/errors.js";
import { lockActor, requireRoomScope } from "../../common/authorization.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { publicUser, userSelect } from "../auth/auth.service.js";

export class RoomsService {
  constructor(pool) { this.pool = pool; }
  async list(user, { page, page_size, status }) {
    const where = `WHERE ($1::boolean OR EXISTS(SELECT 1 FROM user_rooms ur WHERE ur.room_id=r.room_id AND ur.user_id=$2)) AND ($3::text IS NULL OR r.status=$3)`;
    const params = [user.role === "ADMIN", user.user_id, status ?? null];
    const count = await this.pool.query(`SELECT count(*) FROM rooms r ${where}`, params);
    const result = await this.pool.query(`SELECT r.* FROM rooms r ${where} ORDER BY r.room_id LIMIT $4 OFFSET $5`, [...params, page_size, (page - 1) * page_size]);
    return { data: result.rows, meta: { page, page_size, total: Number(count.rows[0].count) } };
  }
  async get(user, id) {
    const room = await requireRoomScope(this.pool, user, id);
    const devices = await this.pool.query(`SELECT device_id,device_code,device_name,device_type,lifecycle_status,connection_status,hardware_version,firmware_version FROM devices WHERE room_id=$1 ORDER BY device_id`, [id]);
    return { ...room, devices: devices.rows };
  }
  async create(actor, input, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "rooms:write");
      const room = (await client.query("INSERT INTO rooms(room_code,room_name) VALUES($1,$2) RETURNING *", [input.room_code, input.room_name])).rows[0];
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "ROOM_CREATE", targetType: "ROOM", targetId: room.room_id, requestId });
      return room;
    });
  }
  async update(actor, id, patch, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "rooms:write");
      const room = requireFound((await client.query("SELECT * FROM rooms WHERE room_id=$1 FOR UPDATE", [id])).rows[0]);
      const updated = (await client.query("UPDATE rooms SET room_name=$1,status=$2,updated_at=now() WHERE room_id=$3 RETURNING *", [patch.room_name ?? room.room_name, patch.status ?? room.status, id])).rows[0];
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "ROOM_UPDATE", targetType: "ROOM", targetId: id, requestId, details: { before_status: room.status, after_status: updated.status, fields: Object.keys(patch) } });
      return updated;
    });
  }
  async members(id, client = this.pool) {
    requireFound((await client.query("SELECT room_id FROM rooms WHERE room_id=$1", [id])).rows[0]);
    return (await client.query(`${userSelect} JOIN user_rooms ur ON ur.user_id=u.user_id WHERE ur.room_id=$1 ORDER BY u.user_id`, [id])).rows.map(publicUser);
  }
  async assignUsers(actor, id, userIds, requestId) {
    return withTransaction(this.pool, async (client) => {
      // Same lock order as account changes; role changes and scope replacement cannot cross.
      await client.query("SELECT pg_advisory_xact_lock(172942,404)");
      await lockActor(client, actor, "rooms:write");
      requireFound((await client.query("SELECT * FROM rooms WHERE room_id=$1 FOR UPDATE", [id])).rows[0]);
      const oldIds = (await client.query("SELECT user_id FROM user_rooms WHERE room_id=$1", [id])).rows.map((r) => r.user_id);
      const allIds = [...new Set([...oldIds, ...userIds])];
      const users = (await client.query(`${userSelect} WHERE u.user_id=ANY($1::bigint[]) ORDER BY u.user_id FOR UPDATE OF u`, [allIds])).rows;
      for (const userId of userIds) {
        const user = users.find((u) => u.user_id === userId);
        if (!user || user.status !== "ACTIVE" || user.role === "ADMIN") throw new AppError("INVALID_ROOM_MEMBER", 400, "Chỉ gán tài khoản Operator/Viewer đang hoạt động");
      }
      const previous = new Set(oldIds);
      const next = new Set(userIds);
      const changed = allIds.filter((userId) => previous.has(userId) !== next.has(userId));
      await client.query("DELETE FROM user_rooms WHERE room_id=$1", [id]);
      if (userIds.length) await client.query("INSERT INTO user_rooms(room_id,user_id) SELECT $1,unnest($2::bigint[])", [id, userIds]);
      if (changed.length) await client.query("UPDATE users SET token_version=token_version+1,updated_at=now() WHERE user_id=ANY($1::bigint[])", [changed]);
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "ROOM_MEMBERS_UPDATE", targetType: "ROOM", targetId: id, requestId, details: { before: oldIds, after: userIds } });
      return this.members(id, client);
    });
  }
}
