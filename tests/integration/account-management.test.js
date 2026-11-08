import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";
import { verifyPassword } from "../../backend/src/common/passwords.js";

const password = "account-test-password-only";
const registration = { username: "new_viewer", password, display_name: "Người xem mới" };
async function fixture(t) {
  const db = await testDatabase(t);
  await seed(db.pool, { username: "test_admin", password, demoPassword: password });
  const http = await testHttp(t, db.pool);
  const login = async (username, secret = password) => http.request("/auth/login", { method: "POST", body: { username, password: secret } });
  const admin = (await login("test_admin")).body.data;
  return { ...db, ...http, login, admin };
}

test("registration, user creation, password change and reset enforce the 8-character minimum", async t => {
  const { request, login, admin } = await fixture(t);
  const valid = "Eight@12";
  const short = "Seven@1";
  for (const [secret, expected] of [[short, 400], [valid, 201]]) {
    assert.equal((await request("/auth/register", { method: "POST", body: { ...registration, password: secret } })).status, expected);
    assert.equal((await request("/users", { method: "POST", token: admin.access_token, body: { username: "eight_operator", display_name: "Eight Operator", role: "OPERATOR", password: secret } })).status, expected);
  }
  const viewer = (await login(registration.username, valid)).body.data;
  for (const [secret, expected] of [[short, 400], ["Next@123", 200]]) {
    assert.equal((await request("/auth/change-password", { method: "POST", token: viewer.access_token, body: { current_password: valid, new_password: secret } })).status, expected);
  }
  assert.equal((await login(registration.username, "Next@123")).status, 200);
  const operator = (await login("eight_operator", valid)).body.data;
  for (const [secret, expected] of [[short, 400], ["Reset@12", 200]]) {
    assert.equal((await request(`/users/${operator.user.user_id}/reset-password`, { method: "POST", token: admin.access_token, body: { new_password: secret } })).status, expected);
  }
  assert.equal((await login("eight_operator", "Reset@12")).status, 200);
});

test("public registration creates only a Viewer with a hashed password and no assigned rooms", async t => {
  const { request, login, pool, sink } = await fixture(t);
  const created = await request("/auth/register", { method: "POST", body: registration });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal(created.body.data.role, "VIEWER");
  assert.equal(created.body.data.status, "ACTIVE");
  assert.equal(created.body.data.password_hash, undefined);
  assert.equal(created.body.data.token_version, undefined);
  assert.equal(created.body.data.access_token, undefined);
  const id = created.body.data.user_id;
  const stored = (await pool.query("SELECT password_hash FROM users WHERE user_id=$1", [id])).rows[0];
  assert.equal(await verifyPassword(password, stored.password_hash), true);
  const session = (await login(registration.username)).body.data;
  assert.equal(session.user.role, "VIEWER");
  assert.equal((await request("/auth/me", { token: session.access_token })).status, 200);
  assert.equal((await request("/users", { token: session.access_token })).status, 403);
  assert.deepEqual((await request("/rooms", { token: session.access_token })).body.data, []);
  const audit = (await pool.query("SELECT * FROM audit_logs WHERE action='USER_REGISTER' AND target_id=$1", [id])).rows;
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes(password));
  assert.ok(!JSON.stringify(sink.getEntries()).includes(password));
});

test("registration rejects role/status injection, weak passwords and duplicate usernames", async t => {
  const { request } = await fixture(t);
  for (const patch of [{ role: "ADMIN" }, { role: "OPERATOR" }, { status: "DISABLED" }, { password: "short" }, { username: "bad space" }, { display_name: "   " }]) {
    assert.equal((await request("/auth/register", { method: "POST", body: { ...registration, ...patch } })).status, 400);
  }
  assert.equal((await request("/auth/register", { method: "POST", body: registration })).status, 201);
  const duplicate = await request("/auth/register", { method: "POST", body: registration });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "USERNAME_TAKEN");
});

test("registration rate limiting is atomic and does not consume login attempts", async t => {
  const { request, login, pool } = await fixture(t);
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => request("/auth/register", { method: "POST", body: { ...registration, username: `rate_viewer_${index}` } })));
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 201, 201, 201, 201, 429]);
  assert.equal((await login("test_admin")).status, 200);
  await pool.query("UPDATE login_attempts SET window_started=now()-interval '16 minutes'");
  assert.equal((await request("/auth/register", { method: "POST", body: registration })).status, 201);
});

test("Admin resets Operator and Viewer passwords, invalidating all their old sessions", async t => {
  const { request, login, admin, pool, sink } = await fixture(t);
  const newPassword = "new-account-password-only";
  for (const username of ["demo_operator", "demo_viewer"]) {
    const first = (await login(username)).body.data;
    const second = (await login(username)).body.data;
    const reset = await request(`/users/${first.user.user_id}/reset-password`, { method: "POST", token: admin.access_token, body: { new_password: newPassword } });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.data, { password_reset: true, login_required: true });
    assert.equal((await request("/auth/me", { token: first.access_token })).status, 401);
    assert.equal((await request("/auth/me", { token: second.access_token })).status, 401);
    assert.equal((await login(username)).status, 401);
    assert.equal((await login(username, newPassword)).status, 200);
  }
  const audit = (await pool.query("SELECT * FROM audit_logs WHERE action='USER_PASSWORD_RESET'")).rows;
  assert.equal(audit.length, 2);
  assert.ok(!JSON.stringify(audit).includes(newPassword));
  assert.ok(!JSON.stringify(sink.getEntries()).includes(newPassword));
});

test("password reset rejects non-admin callers, Admin targets, invalid IDs and weak passwords", async t => {
  const { request, login, admin } = await fixture(t);
  const operator = (await login("demo_operator")).body.data;
  const viewer = (await login("demo_viewer")).body.data;
  const body = { new_password: "another-password-only" };
  const path = `/users/${operator.user.user_id}/reset-password`;
  assert.equal((await request(path, { method: "POST", body })).status, 401);
  for (const session of [operator, viewer]) assert.equal((await request(path, { method: "POST", token: session.access_token, body })).status, 403);
  assert.equal((await request(`/users/${admin.user.user_id}/reset-password`, { method: "POST", token: admin.access_token, body })).status, 403);
  assert.equal((await request("/users/99999/reset-password", { method: "POST", token: admin.access_token, body })).status, 404);
  assert.equal((await request(path, { method: "POST", token: admin.access_token, body: { new_password: "short" } })).status, 400);
  assert.equal((await request(path, { method: "POST", token: admin.access_token, body: { ...body, role: "ADMIN" } })).status, 400);
});

test("audit failure rolls back registration and password reset", async t => {
  const { request, login, admin, owner, pool } = await fixture(t);
  await owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_registration_audit CHECK(action <> 'USER_REGISTER')");
  assert.equal((await request("/auth/register", { method: "POST", body: registration })).status, 500);
  assert.equal((await pool.query("SELECT * FROM users WHERE username=$1", [registration.username])).rowCount, 0);
  const operator = (await login("demo_operator")).body.data;
  await owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_reset_audit CHECK(action <> 'USER_PASSWORD_RESET')");
  assert.equal((await request(`/users/${operator.user.user_id}/reset-password`, { method: "POST", token: admin.access_token, body: { new_password: "rolled-back-password" } })).status, 500);
  assert.equal((await request("/auth/me", { token: operator.access_token })).status, 200);
  assert.equal((await login("demo_operator")).status, 200);
});
