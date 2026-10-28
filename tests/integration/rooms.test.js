import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";

const password = "rooms-test-password-only";
async function fixture(t) {
  const db = await testDatabase(t);
  await seed(db.pool, { username: "test_admin", password, demoPassword: password });
  const http = await testHttp(t, db.pool);
  const login = async (username) => (await http.request("/auth/login", { method: "POST", body: { username, password } })).body.data;
  const admin = await login("test_admin");
  const createRoom = async (room_code) => http.request("/rooms", { method: "POST", token: admin.access_token, body: { room_code, room_name: `Phòng ${room_code}` } });
  const assign = (id, user_ids) => http.request(`/rooms/${id}/users`, { method: "PUT", token: admin.access_token, body: { user_ids } });
  return { ...db, ...http, login, admin, createRoom, assign };
}

test("Admin manages rooms, validates codes and retains inactive room/device history", async (t) => {
  const { createRoom, request, admin, pool } = await fixture(t);
  const token = admin.access_token;
  const created = await createRoom("ROOM_302");
  assert.equal(created.status, 201);
  const id = created.body.data.room_id;
  assert.equal((await createRoom("ROOM_302")).status, 409);
  assert.equal((await createRoom("ROOM/303")).status, 400);
  assert.equal((await request("/rooms/not-an-id", { token })).status, 400);
  await pool.query("INSERT INTO devices(device_code,device_name,device_type,room_id) VALUES('SENSOR_01','Sensor','SENSOR_NODE',$1)", [id]);
  const updated = await request(`/rooms/${id}`, { method: "PATCH", token, body: { room_name: "Phòng đổi tên", status: "INACTIVE" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.status, "INACTIVE");
  const detail = await request(`/rooms/${id}`, { token });
  assert.equal(detail.body.data.devices[0].device_code, "SENSOR_01");
  assert.equal((await request("/rooms?status=INACTIVE", { token })).body.meta.total, 1);
  assert.equal((await request(`/rooms/${id}`, { method: "PATCH", token, body: { room_code: "CHANGED" } })).status, 400);
});

test("room list and direct access enforce scope; Operator/Viewer cannot change rooms or assignments", async (t) => {
  const { createRoom, assign, login, request } = await fixture(t);
  const first = (await createRoom("ROOM_302")).body.data.room_id;
  const other = (await createRoom("ROOM_303")).body.data.room_id;
  for (const username of ["demo_operator", "demo_viewer"]) {
    const before = await login(username);
    assert.equal((await request("/rooms", { token: before.access_token })).body.meta.total, 0);
    assert.equal((await assign(first, [before.user.user_id])).status, 200);
    const user = await login(username);
    const token = user.access_token;
    const list = await request("/rooms", { token });
    assert.equal(list.body.meta.total, 1);
    assert.equal(list.body.data[0].room_id, first);
    assert.equal((await request(`/rooms/${first}`, { token })).status, 200);
    assert.equal((await request(`/rooms/${other}`, { token })).status, 404);
    assert.equal((await request(`/rooms/${other}/users`, { token })).status, 403);
    assert.equal((await request(`/rooms/${first}`, { method: "PATCH", token, body: { status: "INACTIVE" } })).status, 403);
    assert.equal((await request(`/rooms/${first}/users`, { method: "PUT", token, body: { user_ids: [] } })).status, 403);
    assert.equal((await request("/rooms?room_id=" + other, { token })).status, 400);
  }
});

test("scope changes invalidate old sessions, while identical membership replacement is idempotent", async (t) => {
  const { createRoom, assign, login, request } = await fixture(t);
  const id = (await createRoom("ROOM_302")).body.data.room_id;
  const before = await login("demo_viewer");
  assert.equal((await assign(id, [before.user.user_id])).status, 200);
  assert.equal((await request("/rooms", { token: before.access_token })).status, 401);
  const granted = await login("demo_viewer");
  assert.equal((await request(`/rooms/${id}`, { token: granted.access_token })).status, 200);
  assert.equal((await assign(id, [before.user.user_id])).status, 200);
  assert.equal((await request(`/rooms/${id}`, { token: granted.access_token })).status, 200);
  assert.equal((await assign(id, [])).status, 200);
  assert.equal((await request(`/rooms/${id}`, { token: granted.access_token })).status, 401);
  const removed = await login("demo_viewer");
  assert.equal((await request(`/rooms/${id}`, { token: removed.access_token })).status, 404);
});

test("invalid assignments and audit errors do not partially replace membership", async (t) => {
  const { createRoom, assign, login, request, admin, owner } = await fixture(t);
  const id = (await createRoom("ROOM_302")).body.data.room_id;
  const viewer = await login("demo_viewer");
  assert.equal((await assign(id, [viewer.user.user_id])).status, 200);
  const current = await login("demo_viewer");
  assert.equal((await assign(id, [admin.user.user_id])).status, 400);
  assert.equal((await assign(id, ["999999"])).status, 400);
  assert.equal((await assign(id, [viewer.user.user_id, viewer.user.user_id])).status, 400);
  await owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_scope CHECK(action <> 'ROOM_MEMBERS_UPDATE') NOT VALID");
  assert.equal((await assign(id, [])).status, 500);
  assert.equal((await request(`/rooms/${id}`, { token: current.access_token })).status, 200);
  const members = await request(`/rooms/${id}/users`, { token: admin.access_token });
  assert.equal(members.body.data.length, 1);
  assert.equal(members.body.data[0].password_hash, undefined);
});
