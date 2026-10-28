import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "../helpers/database.js";
import { testHttp } from "../helpers/http.js";
import { seed } from "../../backend/src/database/seed.js";

const credentials = { username: "test_admin", password: "auth-test-password-only" };
async function fixture(t) {
  const db = await testDatabase(t);
  await seed(db.pool, credentials);
  return { ...db, ...await testHttp(t, db.pool) };
}
const login = (request, body = credentials) => request("/auth/login", { method: "POST", body });

test("HTTP login, profile and logout invalidate all existing sessions without leaking secrets", async (t) => {
  const { request, sink, pool } = await fixture(t);
  const first = await login(request);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.body.data.user.role, "ADMIN");
  assert.equal(first.body.data.user.password_hash, undefined);
  assert.equal(first.body.data.user.token_version, undefined);
  const token = first.body.data.access_token;
  const second = (await login(request)).body.data.access_token;
  assert.equal((await request("/auth/me", { token })).status, 200);
  assert.equal((await request("/auth/logout", { method: "POST", token })).status, 200);
  assert.equal((await request("/auth/me", { token })).status, 401);
  assert.equal((await request("/auth/me", { token: second })).status, 401);
  assert.ok(!JSON.stringify(sink.getEntries()).includes(token));
  assert.ok(!JSON.stringify(sink.getEntries()).includes(credentials.password));
  assert.equal((await pool.query("SELECT * FROM audit_logs WHERE action='USER_LOGOUT'")).rowCount, 1);
});

test("password change requires current password and invalidates old sessions", async (t) => {
  const { request } = await fixture(t);
  const token = (await login(request)).body.data.access_token;
  const newPassword = "changed-test-password-only";
  assert.equal((await request("/auth/change-password", { method: "POST", token, body: { current_password: "wrong", new_password: newPassword } })).status, 401);
  assert.equal((await request("/auth/me", { token })).status, 200);
  assert.equal((await request("/auth/change-password", { method: "POST", token, body: { current_password: credentials.password, new_password: newPassword } })).status, 200);
  assert.equal((await request("/auth/me", { token })).status, 401);
  assert.equal((await login(request)).status, 401);
  assert.equal((await login(request, { ...credentials, password: newPassword })).status, 200);
});

test("JWT signature, expiry and user status are checked on every protected request", async (t) => {
  const { request, config, pool } = await fixture(t);
  const signedIn = (await login(request)).body.data;
  assert.equal((await request("/auth/me")).status, 401);
  assert.equal((await request("/auth/me", { token: "not-a-jwt" })).status, 401);
  const forged = await new SignJWT({ ver: 1 }).setProtectedHeader({ alg: "HS256" }).setSubject(signedIn.user.user_id).setIssuer("smartclassroom").setAudience("smartclassroom-web").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("wrong-test-key-at-least-thirty-two-characters"));
  assert.equal((await request("/auth/me", { token: forged })).status, 401);
  const expired = await new SignJWT({ ver: 1 }).setProtectedHeader({ alg: "HS256" }).setSubject(signedIn.user.user_id).setIssuer("smartclassroom").setAudience("smartclassroom-web").setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(config.jwtSecret));
  assert.equal((await request("/auth/me", { token: expired })).status, 401);
  await pool.query("UPDATE users SET status='DISABLED' WHERE user_id=$1", [signedIn.user.user_id]);
  assert.equal((await request("/auth/me", { token: signedIn.access_token })).status, 401);
  assert.equal((await login(request)).status, 401);
});

test("login failures persist across service restart and block after five attempts", async (t) => {
  const { request, pool, config } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await login(request, { ...credentials, password: "wrong" })).status, 401);
  assert.equal((await login(request)).status, 429);
  const restarted = await testHttp(t, pool, { config });
  assert.equal((await login(restarted.request)).status, 429);
  await pool.query("UPDATE login_attempts SET window_started=now()-interval '16 minutes'");
  assert.equal((await login(restarted.request)).status, 200);
  const nonexistent = await login(request, { ...credentials, username: "does-not-exist" });
  const incorrect = await login(request, { ...credentials, password: "wrong" });
  assert.deepEqual(nonexistent.body.error, incorrect.body.error);
});

test("auth rejects unexpected fields and audit failure rolls back logout", async (t) => {
  const { request, owner } = await fixture(t);
  assert.equal((await login(request, { ...credentials, role: "ADMIN" })).status, 400);
  const token = (await login(request)).body.data.access_token;
  await owner.query("ALTER TABLE audit_logs ADD CONSTRAINT test_fail_logout CHECK(action <> 'USER_LOGOUT')");
  assert.equal((await request("/auth/logout", { method: "POST", token })).status, 500);
  assert.equal((await request("/auth/me", { token })).status, 200);
});
