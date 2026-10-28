import pg from "pg";

export function createPool(connectionString, { max = 10, options } = {}) {
  if (!connectionString) throw new TypeError("Cần DATABASE_URL");
  return new pg.Pool({ connectionString, max, options, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
}

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
    client.release();
  }
}
