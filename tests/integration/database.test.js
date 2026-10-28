import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { migrate } from "../../backend/src/database/migrate.js";
import { seed } from "../../backend/src/database/seed.js";
import { withTransaction } from "../../backend/src/database/pool.js";
import { writeAudit } from "../../backend/src/database/audit.js";
import { verifyPassword } from "../../backend/src/common/passwords.js";

test("PostgreSQL migrations and seed are repeatable and password is hashed", async (t) => {
  const { pool, owner } = await testDatabase(t);
  assert.equal(await migrate(owner), 0);
  const input = { username: "test_admin", password: "test-only-strong-password", demoPassword: "test-only-demo-password" };
  assert.equal(await seed(pool, input), 3);
  assert.equal(await seed(pool, input), 0);
  const { rows } = await pool.query("SELECT * FROM users ORDER BY user_id");
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0].password_hash, input.password);
  assert.equal(await verifyPassword(input.password, rows[0].password_hash), true);
  assert.equal(await verifyPassword("incorrect-password", rows[0].password_hash), false);
  assert.equal((await pool.query("SELECT * FROM audit_logs")).rowCount, 3);
});

test("runtime database account cannot mutate audit or schema; owner trigger also rejects mutations", async (t) => {
  const { pool, owner } = await testDatabase(t);
  const role = (await pool.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(role.rolsuper, false);
  await writeAudit(pool, { action: "TEST", targetType: "SYSTEM" });
  for (const sql of ["UPDATE audit_logs SET action='changed'", "DELETE FROM audit_logs", "TRUNCATE audit_logs", "CREATE TABLE forbidden(id INTEGER)", "SELECT * FROM schema_migrations"]) {
    await assert.rejects(() => pool.query(sql), (e) => e.code === "42501");
  }
  await assert.rejects(() => owner.query("DELETE FROM audit_logs"), (e) => e.code === "42501");
  assert.equal((await pool.query("SELECT * FROM audit_logs")).rowCount, 1);
});

test("audit failure rolls back business data and transaction releases connection", async (t) => {
  const { pool } = await testDatabase(t);
  await assert.rejects(() => withTransaction(pool, async (client) => {
    await client.query("INSERT INTO rooms(room_code,room_name) VALUES('ROLLBACK','rollback')");
    await writeAudit(client, { action: "BAD", targetType: "ROOM", result: "INVALID" });
  }), (e) => e.code === "23514");
  assert.equal((await pool.query("SELECT * FROM rooms WHERE room_code='ROLLBACK'")).rowCount, 0);
  await withTransaction(pool, async (client) => {
    await client.query("INSERT INTO rooms(room_code,room_name) VALUES('ROOM_302','Phòng 302')");
    await writeAudit(client, { action: "ROOM_CREATE", targetType: "ROOM" });
  });
  assert.equal((await pool.query("SELECT * FROM rooms")).rowCount, 1);
});

test("database constraints reject invalid state and duplicate identities", async (t) => {
  const { pool } = await testDatabase(t);
  await pool.query("INSERT INTO rooms(room_code,room_name) VALUES('ROOM_302','Room')");
  await assert.rejects(() => pool.query("INSERT INTO rooms(room_code,room_name) VALUES('ROOM_302','Duplicate')"), (e) => e.code === "23505");
  await assert.rejects(() => pool.query("INSERT INTO devices(device_code,device_name,device_type,lifecycle_status) VALUES('CTRL_01','Control','CONTROL_NODE','ACTIVE')"), (e) => e.code === "23514");
});
