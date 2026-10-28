import { AppError, requireFound } from "../../common/errors.js";
import { lockActor } from "../../common/authorization.js";
import { hashPassword } from "../../common/passwords.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { publicUser, userSelect } from "../auth/auth.service.js";

export class UsersService {
  constructor(pool) { this.pool = pool; }
  async list({ page, page_size, status, role }) {
    const where = "WHERE ($1::text IS NULL OR u.status=$1) AND ($2::text IS NULL OR r.role_name=$2)";
    const params = [status ?? null, role ?? null];
    const total = (await this.pool.query(`SELECT count(*) FROM users u JOIN roles r ON r.role_id=u.role_id ${where}`, params)).rows[0].count;
    const result = await this.pool.query(`${userSelect} ${where} ORDER BY u.user_id LIMIT $3 OFFSET $4`, [...params, page_size, (page - 1) * page_size]);
    return { data: result.rows.map(publicUser), meta: { page, page_size, total: Number(total) } };
  }
  async get(id) { return publicUser(requireFound((await this.pool.query(`${userSelect} WHERE u.user_id=$1`, [id])).rows[0])); }
  async create(actor, input, requestId) {
    const hash = await hashPassword(input.password);
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(172942,404)");
      await lockActor(client, actor, "users:write");
      const user = (await client.query(`INSERT INTO users(username,password_hash,display_name,role_id)
        SELECT $1,$2,$3,role_id FROM roles WHERE role_name=$4 RETURNING user_id`, [input.username, hash, input.display_name, input.role])).rows[0];
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "USER_CREATE", targetType: "USER", targetId: user.user_id, requestId, details: { role: input.role } });
      return publicUser((await client.query(`${userSelect} WHERE u.user_id=$1`, [user.user_id])).rows[0]);
    });
  }
  async update(actor, id, patch, requestId) {
    return withTransaction(this.pool, async (client) => {
      // Serialize admin changes to preserve the last active admin and avoid crossed user locks.
      await client.query("SELECT pg_advisory_xact_lock(172942,404)");
      await lockActor(client, actor, "users:write");
      const user = requireFound((await client.query(`${userSelect} WHERE u.user_id=$1 FOR UPDATE OF u`, [id])).rows[0]);
      const role = patch.role ?? user.role;
      const status = patch.status ?? user.status;
      const permissionsChanged = role !== user.role || status !== user.status;
      if (user.role === "ADMIN" && user.status === "ACTIVE" && (role !== "ADMIN" || status !== "ACTIVE")) {
        const admins = (await client.query("SELECT count(*) FROM users u JOIN roles r ON r.role_id=u.role_id WHERE r.role_name='ADMIN' AND u.status='ACTIVE'")).rows[0].count;
        if (Number(admins) <= 1) throw new AppError("LAST_ADMIN", 409, "Phải giữ ít nhất một Admin đang hoạt động");
      }
      await client.query(`UPDATE users SET display_name=$1,status=$2,role_id=(SELECT role_id FROM roles WHERE role_name=$3),
        token_version=token_version+$4,updated_at=now() WHERE user_id=$5`, [patch.display_name ?? user.display_name, status, role, permissionsChanged ? 1 : 0, id]);
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "USER_UPDATE", targetType: "USER", targetId: id, requestId, details: { before: { role: user.role, status: user.status }, after: { role, status }, fields: Object.keys(patch) } });
      return publicUser((await client.query(`${userSelect} WHERE u.user_id=$1`, [id])).rows[0]);
    });
  }
}
