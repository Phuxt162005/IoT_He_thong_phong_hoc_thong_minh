import { readdir } from "node:fs/promises";
export async function expectedSchemaVersion() {
  return (await readdir(new URL("../../../database/migrations/", import.meta.url))).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort().at(-1);
}
export async function schemaReady(pool, expected) {
  const row = (await pool.query("SELECT version FROM backend_schema_state WHERE singleton")).rows[0];
  return row?.version === expected;
}
