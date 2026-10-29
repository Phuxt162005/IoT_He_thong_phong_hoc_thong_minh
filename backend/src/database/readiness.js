import { readdir } from "node:fs/promises";
// Phiên bản code yêu cầu là tên migration cuối cùng, sắp xếp theo tiền tố số thứ tự.
export async function expectedSchemaVersion() {
  return (await readdir(new URL("../../../database/migrations/", import.meta.url))).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort().at(-1);
}
// Đối chiếu với phiên bản do migrator ghi; tài khoản runtime chỉ được đọc bảng này.
// /ready chưa thành công nếu database chưa được nâng cấp đúng phiên bản code đang chạy.
export async function schemaReady(pool, expected) {
  const row = (await pool.query("SELECT version FROM backend_schema_state WHERE singleton")).rows[0];
  return row?.version === expected;
}
