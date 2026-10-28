import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";
import { verifyPassword } from "../../backend/src/common/passwords.js";

const password = "users-test-password-only";
async function fixture(t) {
  const db = await testDatabase(t);
  await seed(db.pool, { username: "test_admin", password, demoPassword: password });
  const http = await testHttp(t, db.pool);
  const login = async (username) => http.request("/auth/login", { method: "POST", body: { username, password } });
  const admin = (await login("test_admin")).body.data;
  return { ...db, ...http, login, admin };
}

test("Admin creates, lists and reads users with safe output and validated input", async (t) => {
  const { request, admin, pool } = await fixture(t);
  const token = admin.access_token;
  const body = { username: "operator_new", password, display_name: "Operator mới", role: "OPERATOR" };
  const created = await request("/users", { method: "POST", token, body });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.role, "OPERATOR");
  assert.equal(created.body.data.password_hash, undefined);
  assert.equal(created.body.data.token_version, undefined);
  const id = created.body.data.user_id;
  assert.equal(typeof id, "string");
  assert.equal((await request(`/users/${id}`, { token })).status, 200);
  const filtered = await request("/users?role=OPERATOR&page=1&page_size=1", { token });
  assert.equal(filtered.body.meta.total, 2);
  assert.equal(filtered.body.data.length, 1);
  assert.equal((await request("/users?page_size=1000", { token })).status, 400);
  assert.equal((await request("/users/99999999999999999999", { token })).status, 400);
  assert.equal((await request("/users", { method: "POST", token, body })).status, 409);
  assert.equal((await request("/users", { method: "POST", token, body: { ...body, username: "bad_password", password: "short" } })).status, 400);
  assert.equal((await request(`/users/${id}`, { method: "PATCH", token, body: { password_hash: "injected" } })).status, 400);
  const stored = (await pool.query("SELECT password_hash FROM users WHERE user_id=$1", [id])).rows[0].password_hash;
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal((await pool.query("SELECT * FROM audit_logs WHERE action='USER_CREATE'")).rowCount, 1);
});

test("Operator and Viewer cannot administer accounts or promote themselves", async (t) => {
  const { request, login, pool } = await fixture(t);
  for (const username of ["demo_operator", "demo_viewer"]) {
    const data = (await login(username)).body.data;
    assert.equal((await request("/users", { token: data.access_token })).status, 403);
    assert.equal((await request(`/users/${data.user.user_id}`, { method: "PATCH", token: data.access_token, body: { role: "ADMIN" } })).status, 403);
    assert.equal((await request("/users", { method: "POST", token: data.access_token, body: { username: "new_admin", password, display_name: "Injected", role: "ADMIN" } })).status, 403);
  }
  assert.equal((await pool.query("SELECT * FROM audit_logs WHERE action='ACCESS_DENIED' AND result='DENIED'")).rowCount, 6);
});

test("changing role or status invalidates existing JWT immediately and re-enable does not resurrect it", async (t) => {
  const { request, admin, login } = await fixture(t);
  const operator = (await login("demo_operator")).body.data;
  const path = `/users/${operator.user.user_id}`;
  assert.equal((await request(path, { method: "PATCH", token: admin.access_token, body: { role: "VIEWER" } })).status, 200);
  assert.equal((await request("/auth/me", { token: operator.access_token })).status, 401);
  const viewer = (await login("demo_operator")).body.data;
  assert.equal(viewer.user.role, "VIEWER");
  assert.equal((await request(path, { method: "PATCH", token: admin.access_token, body: { status: "DISABLED" } })).status, 200);
  assert.equal((await request("/auth/me", { token: viewer.access_token })).status, 401);
  assert.equal((await login("demo_operator")).status, 401);
  assert.equal((await request(path, { method: "PATCH", token: admin.access_token, body: { status: "ACTIVE" } })).status, 200);
  assert.equal((await request("/auth/me", { token: viewer.access_token })).status, 401);
  assert.equal((await login("demo_operator")).status, 200);
});

test("concurrent admin demotions cannot remove the last active admin", async (t) => {
  const { request, admin, login, pool } = await fixture(t);
  const other = await request("/users", { method: "POST", token: admin.access_token, body: { username: "second_admin", password, display_name: "Second", role: "ADMIN" } });
  assert.equal(other.status, 201);
  const second = (await login("second_admin")).body.data;
  const results = await Promise.all([
    request(`/users/${admin.user.user_id}`, { method: "PATCH", token: admin.access_token, body: { role: "VIEWER" } }),
    request(`/users/${second.user.user_id}`, { method: "PATCH", token: second.access_token, body: { role: "VIEWER" } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(Number((await pool.query("SELECT count(*) FROM users u JOIN roles r ON r.role_id=u.role_id WHERE r.role_name='ADMIN' AND u.status='ACTIVE'")).rows[0].count), 1);
});

test("authenticated API rate limit is atomic at the 100-request boundary", async (t) => {
  const { request, admin, pool } = await fixture(t);
  await pool.query("INSERT INTO api_rate_limits(user_id,window_started,request_count) VALUES($1,now(),99)", [admin.user.user_id]);
  const results = await Promise.all([request("/auth/me", { token: admin.access_token }), request("/auth/me", { token: admin.access_token })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  assert.equal(results.find((r) => r.status === 429).headers.get("retry-after"), "60");
});
