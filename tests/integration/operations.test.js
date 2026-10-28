import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { seed } from "../../backend/src/database/seed.js";
import { expectedSchemaVersion, schemaReady } from "../../backend/src/database/readiness.js";
import { runRetention } from "../../backend/src/database/retention.js";

test("schema readiness requires the expected migration and runtime cannot forge its version", async (t) => {
  const db = await testDatabase(t);
  assert.equal(await schemaReady(db.pool, await expectedSchemaVersion()), true);
  assert.equal(await schemaReady(db.pool, "999_future.sql"), false);
  await assert.rejects(db.pool.query("UPDATE backend_schema_state SET version='999_future.sql'"), { code: "42501" });
  await assert.rejects(db.pool.query("INSERT INTO backend_schema_state VALUES(true,'forged',now())"), { code: "42501" });
});

test("retention bounds batches, preserves audit and rolls back deletion if its audit fails", async (t) => {
  const db = await testDatabase(t);
  await seed(db.pool, { username: "test_admin", password: "retention-test-password" });
  const room = (await db.pool.query("INSERT INTO rooms(room_code,room_name) VALUES('RETENTION','Retention') RETURNING room_id")).rows[0];
  const device = (await db.pool.query("INSERT INTO devices(device_code,device_name,device_type,room_id) VALUES('RET_SENSOR','Sensor','SENSOR_NODE',$1) RETURNING device_id", [room.room_id])).rows[0];
  await db.pool.query(`INSERT INTO sensor_data(device_id,room_id,msg_id,recorded_at,received_at,temperature,humidity,lux,payload_hash)
    SELECT $1,$2,'old_' || x,now()-interval '100 days',now(),25,50,100,repeat('0',64) FROM generate_series(1,3) x`, [device.device_id, room.room_id]);
  await db.pool.query("INSERT INTO sensor_data(device_id,room_id,msg_id,recorded_at,received_at,temperature,humidity,lux,payload_hash) VALUES($1,$2,'new',now(),now(),25,50,100,repeat('0',64))", [device.device_id, room.room_id]);
  await db.owner.query("ALTER TABLE audit_logs ADD CONSTRAINT no_retention CHECK(action <> 'DATA_RETENTION') NOT VALID");
  await assert.rejects(runRetention(db.pool, { batchSize: 2 }));
  assert.equal((await db.pool.query("SELECT * FROM sensor_data")).rowCount, 4);
  await db.owner.query("ALTER TABLE audit_logs DROP CONSTRAINT no_retention");
  assert.equal((await runRetention(db.pool, { batchSize: 2 })).sensor_data_deleted, 2);
  assert.equal((await runRetention(db.pool, { batchSize: 2 })).sensor_data_deleted, 1);
  assert.equal((await runRetention(db.pool)).sensor_data_deleted, 0);
  assert.equal((await db.pool.query("SELECT * FROM sensor_data")).rows[0].msg_id, "new");
  assert.equal((await db.pool.query("SELECT * FROM audit_logs WHERE action='DATA_RETENTION'")).rowCount, 2);
  assert.ok((await db.pool.query("SELECT * FROM audit_logs WHERE action='USER_SEED'")).rowCount);
  await assert.rejects(runRetention(db.pool, { sensorDays: 0 }));
});
