import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../../../database/migrations/", import.meta.url));

export async function migrate(pool, { appRole = "smartclass_app" } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new TypeError("Tên database role không hợp lệ");
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("SELECT pg_advisory_lock(172942, 200)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const name of files) {
      const sql = (await readFile(new URL(`../../../database/migrations/${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name]);
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`Migration đã áp dụng bị sửa: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
        await client.query("COMMIT");
        applied++;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    // Runtime role cannot mutate schema or audit records. Only migrations use the owner account.
    const schema = (await client.query("SELECT current_schema() AS name")).rows[0].name;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Schema không hợp lệ");
    await client.query("BEGIN");
    try {
      await client.query(`REVOKE CREATE ON SCHEMA "${schema}" FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${appRole}"`);
      await client.query(`REVOKE ALL ON schema_migrations FROM "${appRole}"`);
      await client.query(`REVOKE ALL ON audit_logs FROM "${appRole}"`);
      await client.query(`GRANT SELECT, INSERT ON audit_logs TO "${appRole}"`);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    return applied;
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(172942, 200)"); } finally { client.release(); }
  }
}
