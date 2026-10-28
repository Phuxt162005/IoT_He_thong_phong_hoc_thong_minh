import "dotenv/config";
import { createPool } from "./pool.js";
import { loadConfig } from "../config.js";
import { runRetention } from "./retention.js";
let pool;
try {
  const config = loadConfig(process.env, { requireDatabase: true });
  pool = createPool(config.databaseUrl);
  console.log(JSON.stringify(await runRetention(pool, { sensorDays: config.sensorRetentionDays, eventDays: config.eventRetentionDays })));
} catch { console.error(JSON.stringify({ error: "RETENTION_FAILED" })); process.exitCode = 1; }
finally { await pool?.end(); }
