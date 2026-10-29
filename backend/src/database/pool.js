import pg from "pg";

// Dùng lại kết nối PostgreSQL và giới hạn thời gian chờ kết nối/truy vấn.
// options cho phép bộ kiểm thử chọn schema riêng mà không sửa truy vấn nghiệp vụ.
export function createPool(connectionString, { max = 10, options } = {}) {
  if (!connectionString) throw new TypeError("Cần DATABASE_URL");
  return new pg.Pool({ connectionString, max, options, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
}

// Mọi truy vấn trong work phải dùng client được truyền vào, kể cả truy vấn ghi audit.
// Dùng pool.query ở giữa work có thể chạy trên kết nối khác và nằm ngoài transaction này.
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    // Trả kết nối về pool trong cả trường hợp thành công và thất bại để tránh cạn kết nối.
    client.release();
  }
}
