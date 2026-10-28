import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { createPool } from "../../backend/src/database/pool.js";
import { migrate } from "../../backend/src/database/migrate.js";

dotenv.config({ path: ".env.test", quiet: true });

export async function testDatabase(t) {
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const appUrl = process.env.TEST_DATABASE_URL;
  if (!ownerUrl || !appUrl || ![ownerUrl, appUrl].every((u) => /_test$/.test(new URL(u).pathname))) {
    throw new Error("Integration test cần TEST_*DATABASE_URL riêng với database kết thúc bằng _test");
  }
  const schema = `test_${randomBytes(12).toString("hex")}`;
  const admin = createPool(ownerUrl);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const options = `-c search_path=${schema}`;
  const owner = createPool(ownerUrl, { options });
  const pool = createPool(appUrl, { options });
  t.after(async () => {
    await pool.end();
    await owner.end();
    // Only the isolated random schema created above can be dropped.
    if (!/^test_[a-f0-9]{24}$/.test(schema)) throw new Error("Unsafe test schema");
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  await migrate(owner);
  return { pool, owner, schema };
}
