import { hashPassword } from "../common/passwords.js";
import { withTransaction } from "./pool.js";
import { writeAudit } from "./audit.js";

export async function seed(pool, { username, password, demoPassword } = {}) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error("Cần ADMIN_USERNAME hợp lệ");
  const adminHash = await hashPassword(password);
  const demoHash = demoPassword ? await hashPassword(demoPassword) : null;
  return withTransaction(pool, async (client) => {
    for (const role of ["ADMIN", "OPERATOR", "VIEWER"]) await client.query("INSERT INTO roles(role_name) VALUES($1) ON CONFLICT DO NOTHING", [role]);
    const create = async (name, hash, role) => {
      const result = await client.query(`INSERT INTO users(username,password_hash,display_name,role_id)
        SELECT $1,$2,$1,role_id FROM roles WHERE role_name=$3 ON CONFLICT(username) DO NOTHING RETURNING user_id`, [name, hash, role]);
      if (result.rowCount) await writeAudit(client, { action: "USER_SEED", targetType: "USER", targetId: result.rows[0].user_id, details: { role } });
      return result.rowCount;
    };
    let inserted = await create(username, adminHash, "ADMIN");
    if (demoHash) {
      inserted += await create("demo_operator", demoHash, "OPERATOR");
      inserted += await create("demo_viewer", demoHash, "VIEWER");
    }
    return inserted;
  });
}
