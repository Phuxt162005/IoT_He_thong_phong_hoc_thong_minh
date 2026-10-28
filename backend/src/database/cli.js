import "dotenv/config";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";

let pool;
try {
  const command = process.argv[2];
  if (!["migrate", "seed"].includes(command)) throw new Error("Lệnh không hợp lệ");
  pool = createPool(command === "migrate" ? process.env.MIGRATION_DATABASE_URL : process.env.DATABASE_URL);
  const result = command === "migrate" ? await migrate(pool) : await seed(pool, {
    username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD,
    demoPassword: process.env.SEED_DEMO_USERS === "true" ? process.env.DEMO_PASSWORD : undefined,
  });
  console.log(JSON.stringify({ command, applied: result }));
} catch (error) {
  console.error(JSON.stringify({ error: "DATABASE_COMMAND_FAILED", code: error.code ?? "CONFIG_OR_MIGRATION_ERROR" }));
  process.exitCode = 1;
} finally { await pool?.end(); }
