import "dotenv/config";
import { createPool } from "./pool.js";
import { loadConfig } from "../config.js";
import { runRetention } from "./retention.js";
// Lệnh npm run db:retention chủ động chạy một lượt, không phụ thuộc cờ bật lịch tự động.
// Lỗi chỉ được báo bằng mã chung, không in chuỗi kết nối hay SQL có dữ liệu nhạy cảm.
let pool;
try {
  const config = loadConfig(process.env, { requireDatabase: true });
  pool = createPool(config.databaseUrl);
  console.log(JSON.stringify(await runRetention(pool, { sensorDays: config.sensorRetentionDays, eventDays: config.eventRetentionDays })));
} catch { console.error(JSON.stringify({ error: "RETENTION_FAILED" })); process.exitCode = 1; }
// Luôn đóng pool để tiến trình CLI có thể kết thúc, kể cả khi lượt dọn thất bại.
finally { await pool?.end(); }
