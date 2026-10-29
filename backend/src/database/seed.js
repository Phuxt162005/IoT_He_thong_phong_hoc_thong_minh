import { hashPassword } from "../common/passwords.js";
import { withTransaction } from "./pool.js";
import { writeAudit } from "./audit.js";

// Khởi tạo vai trò và tài khoản ban đầu; trả về số tài khoản vừa được tạo.
// Có thể chạy lại sau mỗi lần triển khai mà không thay đổi tài khoản đã tồn tại.
export async function seed(pool, { username, password, demoPassword } = {}) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error("Cần ADMIN_USERNAME hợp lệ");
  // Băm trước khi mở transaction để giảm thời gian giữ kết nối và khóa database.
  const adminHash = await hashPassword(password);
  const demoHash = demoPassword ? await hashPassword(demoPassword) : null;
  return withTransaction(pool, async (client) => {
    for (const role of ["ADMIN", "OPERATOR", "VIEWER"]) await client.query("INSERT INTO roles(role_name) VALUES($1) ON CONFLICT DO NOTHING", [role]);
    const create = async (name, hash, role) => {
      // DO NOTHING giữ nguyên mật khẩu/quyền hiện có; seed không phải thao tác đặt lại tài khoản.
      const result = await client.query(`INSERT INTO users(username,password_hash,display_name,role_id)
        SELECT $1,$2,$1,role_id FROM roles WHERE role_name=$3 ON CONFLICT(username) DO NOTHING RETURNING user_id`, [name, hash, role]);
      // Tạo tài khoản và ghi audit cùng transaction: một trong hai lỗi thì không lưu thay đổi.
      if (result.rowCount) await writeAudit(client, { action: "USER_SEED", targetType: "USER", targetId: result.rows[0].user_id, details: { role } });
      return result.rowCount;
    };
    let inserted = await create(username, adminHash, "ADMIN");
    // Chỉ tạo Operator/Viewer thử nghiệm khi bên gọi chủ động cung cấp demoPassword.
    if (demoHash) {
      inserted += await create("demo_operator", demoHash, "OPERATOR");
      inserted += await create("demo_viewer", demoHash, "VIEWER");
    }
    return inserted;
  });
}
