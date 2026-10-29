import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../../../database/migrations/", import.meta.url));

export async function migrate(pool, { appRole = "smartclass_app" } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new TypeError("Tên database role không hợp lệ");
  const client = await pool.connect();
  let applied = 0;
  try {
    // Khóa theo phiên PostgreSQL để hai tiến trình triển khai không chạy migration đồng thời.
    await client.query("SELECT pg_advisory_lock(172942, 200)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const name of files) {
      const sql = (await readFile(new URL(`../../../database/migrations/${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
      // Checksum bao gồm cả ghi chú SQL: không sửa migration đã áp dụng, kể cả chỉ dịch comment.
      // Thay đổi schema về sau phải được viết thành file migration mới.
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`Migration đã áp dụng bị sửa: ${name}`);
        continue;
      }
      // Mỗi file là một transaction: chỉ đánh dấu đã áp dụng sau khi toàn bộ SQL thành công.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
        await client.query("COMMIT");
        applied++;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    // Chỉ migrator dùng tài khoản sở hữu schema; runtime bị giới hạn quyền sửa cấu trúc/nhật ký.
    const schema = (await client.query("SELECT current_schema() AS name")).rows[0].name;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Schema không hợp lệ");
    await client.query("BEGIN");
    try {
      await client.query(`REVOKE CREATE ON SCHEMA "${schema}" FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`REVOKE ALL ON schema_migrations FROM "${appRole}"`);
      // Công bố phiên bản cho readiness sau khi đã kiểm tra/áp dụng toàn bộ migration.
      if ((await client.query("SELECT to_regclass('backend_schema_state') AS name")).rows[0].name) {
        await client.query("INSERT INTO backend_schema_state(singleton,version) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET version=EXCLUDED.version,updated_at=now()", [files.at(-1)]);
        await client.query(`REVOKE ALL ON backend_schema_state FROM "${appRole}"`);
        await client.query(`GRANT SELECT ON backend_schema_state TO "${appRole}"`);
      }
      await client.query(`REVOKE ALL ON audit_logs FROM "${appRole}"`);
      await client.query(`GRANT SELECT, INSERT ON audit_logs TO "${appRole}"`);
      if ((await client.query("SELECT to_regclass('device_lifecycle_events') AS name")).rows[0].name) {
        await client.query(`REVOKE ALL ON device_lifecycle_events FROM "${appRole}"`);
        await client.query(`GRANT SELECT, INSERT ON device_lifecycle_events TO "${appRole}"`);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    return applied;
  } finally {
    // Advisory lock thuộc kết nối: phải mở khóa trước khi trả client về pool.
    try { await client.query("SELECT pg_advisory_unlock(172942, 200)"); } finally { client.release(); }
  }
}
