import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { AppError } from "../../common/errors.js";
import { hashPassword, verifyPassword } from "../../common/passwords.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";

const unauthorized = () => new AppError("UNAUTHORIZED", 401, "Thông tin đăng nhập hoặc phiên truy cập không hợp lệ");
const dummyHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;
export const userSelect = `SELECT u.user_id,u.username,u.display_name,u.status,u.token_version,r.role_name AS role FROM users u JOIN roles r ON r.role_id=u.role_id`;
export function publicUser(user) {
  const { user_id, username, display_name, role, status } = user;
  return { user_id, username, display_name, role, status };
}

export class AuthService {
  constructor({ pool, jwtSecret, jwtExpiresIn = 3600 }) {
    if (!pool || typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret) < 32) throw new TypeError("Cần pool và JWT_SECRET tối thiểu 32 byte");
    this.pool = pool;
    this.key = new TextEncoder().encode(jwtSecret);
    this.jwtExpiresIn = jwtExpiresIn;
  }

  async issueToken(user) {
    return new SignJWT({ ver: user.token_version }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.user_id).setIssuer("smartclassroom").setAudience("smartclassroom-web")
      .setIssuedAt().setExpirationTime(`${this.jwtExpiresIn}s`).sign(this.key);
  }

  async authenticate(authorization) {
    const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization);
    if (!match) throw unauthorized();
    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], this.key, { algorithms: ["HS256"], issuer: "smartclassroom", audience: "smartclassroom-web", requiredClaims: ["sub", "ver", "exp", "iat"] }));
    } catch { throw unauthorized(); }
    if (!/^[1-9]\d{0,18}$/.test(payload.sub ?? "") || BigInt(payload.sub) > 9223372036854775807n || !Number.isSafeInteger(payload.ver) || payload.ver < 1) throw unauthorized();
    const user = (await this.pool.query(`${userSelect} WHERE u.user_id=$1`, [payload.sub])).rows[0];
    if (!user || user.status !== "ACTIVE" || user.token_version !== payload.ver) throw unauthorized();
    return user;
  }

  async login({ username, password }, { ip, requestId } = {}) {
    const loginKey = createHmac("sha256", this.key).update(JSON.stringify([ip ?? "unknown", username.toLowerCase()])).digest("hex");
    const outcome = await withTransaction(this.pool, async (client) => {
      await client.query("INSERT INTO login_attempts(login_key) VALUES($1) ON CONFLICT DO NOTHING", [loginKey]);
      let attempt = (await client.query("SELECT *, now() AS current_time FROM login_attempts WHERE login_key=$1 FOR UPDATE", [loginKey])).rows[0];
      if (attempt.current_time - attempt.window_started >= 15 * 60 * 1000) {
        attempt = (await client.query("UPDATE login_attempts SET failures=0,window_started=now() WHERE login_key=$1 RETURNING *", [loginKey])).rows[0];
      }
      if (attempt.failures >= 5) return { limited: true };
      const user = (await client.query(`${userSelect.replace("SELECT ", "SELECT u.password_hash,")} WHERE u.username=$1 FOR UPDATE OF u`, [username])).rows[0];
      const valid = await verifyPassword(password, user?.password_hash ?? dummyHash);
      if (!valid || !user || user.status !== "ACTIVE") {
        await client.query("UPDATE login_attempts SET failures=failures+1 WHERE login_key=$1", [loginKey]);
        await writeAudit(client, { actorType: "USER", actorId: user?.user_id ?? null, action: "USER_LOGIN", targetType: "USER", targetId: user?.user_id, result: "FAILURE", requestId });
        return { invalid: true };
      }
      await client.query("UPDATE login_attempts SET failures=0,window_started=now() WHERE login_key=$1", [loginKey]);
      await writeAudit(client, { actorType: "USER", actorId: user.user_id, action: "USER_LOGIN", targetType: "USER", targetId: user.user_id, requestId });
      return { user };
    });
    if (outcome.limited) throw new AppError("LOGIN_RATE_LIMITED", 429, "Thử lại sau tối đa 15 phút");
    if (outcome.invalid) throw unauthorized();
    return { access_token: await this.issueToken(outcome.user), token_type: "Bearer", expires_in: this.jwtExpiresIn, user: publicUser(outcome.user) };
  }

  async logout(user, requestId) {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query("UPDATE users SET token_version=token_version+1,updated_at=now() WHERE user_id=$1 AND token_version=$2 AND status='ACTIVE' RETURNING user_id", [user.user_id, user.token_version]);
      if (!result.rowCount) throw unauthorized();
      await writeAudit(client, { actorType: "USER", actorId: user.user_id, action: "USER_LOGOUT", targetType: "USER", targetId: user.user_id, requestId });
    });
  }

  async changePassword(user, { current_password, new_password }, requestId) {
    const passwordHash = await hashPassword(new_password);
    const changed = await withTransaction(this.pool, async (client) => {
      const current = (await client.query("SELECT * FROM users WHERE user_id=$1 FOR UPDATE", [user.user_id])).rows[0];
      if (!current || current.status !== "ACTIVE" || current.token_version !== user.token_version) throw unauthorized();
      if (!await verifyPassword(current_password, current.password_hash)) {
        await writeAudit(client, { actorType: "USER", actorId: user.user_id, action: "USER_PASSWORD_CHANGE", targetType: "USER", targetId: user.user_id, result: "DENIED", requestId });
        return false;
      }
      await client.query("UPDATE users SET password_hash=$1,token_version=token_version+1,updated_at=now() WHERE user_id=$2", [passwordHash, user.user_id]);
      await writeAudit(client, { actorType: "USER", actorId: user.user_id, action: "USER_PASSWORD_CHANGE", targetType: "USER", targetId: user.user_id, requestId });
      return true;
    });
    if (!changed) throw unauthorized();
  }
}
