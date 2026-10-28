import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";

// Only generates new files; never overwrites the user's existing configuration.
try { await access(".env"); throw new Error("EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw new Error(".env đã tồn tại; giữ nguyên cấu hình hiện có"); }
try { await access(".env.test"); throw new Error("EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw new Error(".env.test đã tồn tại; giữ nguyên cấu hình hiện có"); }
const owner = randomBytes(24).toString("hex");
const app = randomBytes(24).toString("hex");
const admin = randomBytes(24).toString("hex");
const common = `POSTGRES_PASSWORD=${owner}\nPOSTGRES_APP_PASSWORD=${app}\n`;
await writeFile(".env", `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nCORS_ORIGINS=http://localhost:5173\n${common}DATABASE_URL=postgres://smartclass_app:${app}@127.0.0.1:5433/smartclass\nMIGRATION_DATABASE_URL=postgres://smartclass_owner:${owner}@127.0.0.1:5433/smartclass\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${admin}\n`, { flag: "wx", mode: 0o600 });
await writeFile(".env.test", `NODE_ENV=test\nTEST_DATABASE_URL=postgres://smartclass_app:${app}@127.0.0.1:5434/smartclass_test\nTEST_MIGRATION_DATABASE_URL=postgres://smartclass_owner:${owner}@127.0.0.1:5434/smartclass_test\n`, { flag: "wx", mode: 0o600 });
console.log("Đã tạo .env và .env.test với mật khẩu ngẫu nhiên; không in secret. Xem ADMIN_PASSWORD trong .env để đăng nhập khi BE-03 hoàn thành.");
