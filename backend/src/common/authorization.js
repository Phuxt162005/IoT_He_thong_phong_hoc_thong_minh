import { AppError, requireFound } from "./errors.js";
import { userSelect } from "../modules/auth/auth.service.js";
import { writeAudit } from "../database/audit.js";

const all = ["ADMIN", "OPERATOR", "VIEWER"];
const permissions = Object.freeze({
  "users:read": ["ADMIN"], "users:write": ["ADMIN"],
  "rooms:read": all, "rooms:write": ["ADMIN"],
  "devices:read": all, "devices:write": ["ADMIN"],
  "telemetry:read": all, "dashboard:read": all,
  "commands:read": all, "commands:create": ["ADMIN", "OPERATOR"],
  "configs:read": all, "configs:write": ["ADMIN"],
  "alerts:read": all, "alerts:write": ["ADMIN", "OPERATOR"],
  "thresholds:write": ["ADMIN"], "rules:read": all, "rules:write": ["ADMIN"],
  "audit:read": ["ADMIN"],
});
export function can(user, permission) { return permissions[permission]?.includes(user.role) ?? false; }

export function authorize(pool, permission) {
  return async (req, _res, next) => {
    if (!can(req.user, permission)) {
      await writeAudit(pool, { actorType: "USER", actorId: req.user.user_id, action: "ACCESS_DENIED", targetType: "PERMISSION", targetId: permission, result: "DENIED", requestId: req.requestId });
      throw new AppError("FORBIDDEN", 403, "Không có quyền thực hiện thao tác");
    }
    next();
  };
}

export async function lockActor(client, user, permission) {
  const current = (await client.query(`${userSelect} WHERE u.user_id=$1 FOR UPDATE OF u`, [user.user_id])).rows[0];
  if (!current || current.status !== "ACTIVE" || current.token_version !== user.token_version) throw new AppError("UNAUTHORIZED", 401, "Phiên truy cập đã hết hiệu lực");
  if (!can(current, permission)) throw new AppError("FORBIDDEN", 403, "Không có quyền thực hiện thao tác");
  return current;
}

export async function requireRoomScope(client, user, roomId) {
  const result = await client.query(`SELECT r.* FROM rooms r WHERE r.room_id=$1
    AND ($2::boolean OR EXISTS(SELECT 1 FROM user_rooms ur WHERE ur.room_id=r.room_id AND ur.user_id=$3))`, [roomId, user.role === "ADMIN", user.user_id]);
  return requireFound(result.rows[0], "Không tìm thấy phòng trong phạm vi truy cập");
}

export function apiRateLimit(pool) {
  return async (req, res, next) => {
    const result = await pool.query(`INSERT INTO api_rate_limits(user_id,window_started,request_count) VALUES($1,now(),1)
      ON CONFLICT(user_id) DO UPDATE SET
      request_count=CASE WHEN api_rate_limits.window_started > now()-interval '60 seconds' THEN api_rate_limits.request_count+1 ELSE 1 END,
      window_started=CASE WHEN api_rate_limits.window_started > now()-interval '60 seconds' THEN api_rate_limits.window_started ELSE now() END RETURNING request_count`, [req.user.user_id]);
    if (result.rows[0].request_count > 100) {
      res.set("Retry-After", "60");
      throw new AppError("API_RATE_LIMITED", 429, "Vượt giới hạn 100 yêu cầu mỗi phút");
    }
    next();
  };
}
