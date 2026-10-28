import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture } from "../helpers/iot.js";
import { writeAudit } from "../../backend/src/database/audit.js";

test("Admin traces actions by actor, target, request and time with validated pagination", async (t) => {
  const f = await iotFixture(t);
  const room = await f.request("/rooms", { method: "POST", token: f.token, headers: { "X-Request-Id": "audit-trace-123" }, body: { room_code: "AUDIT_ROOM", room_name: "Audited room" } });
  assert.equal(room.status, 201);
  const result = await f.request(`/audit-logs?action=ROOM_CREATE&target_type=ROOM&target_id=${room.body.data.room_id}&actor_type=USER&result=SUCCESS&request_id=audit-trace-123&page_size=1`, { token: f.token });
  assert.equal(result.status, 200); assert.equal(result.body.meta.total, 1);
  assert.equal(result.body.data[0].request_id, "audit-trace-123"); assert.ok(result.body.data[0].actor_id);
  assert.equal((await f.request("/audit-logs?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z", { token: f.token })).status, 400);
  assert.equal((await f.request("/audit-logs?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z", { token: f.token })).status, 400);
  assert.equal((await f.request("/audit-logs?action=ROOM_CREATE%27%20OR%201=1", { token: f.token })).status, 400);
  assert.equal((await f.request("/audit-logs?page_size=101", { token: f.token })).status, 400);
});

test("Operators and Viewers cannot read global audit; no API mutates audit records", async (t) => {
  const f = await iotFixture(t);
  for (const role of ["VIEWER", "OPERATOR"]) {
    await f.request("/users", { method: "POST", token: f.token, body: { username: `audit_${role}`, password: "audit-role-test-password", display_name: role, role } });
    const token = (await f.request("/auth/login", { method: "POST", body: { username: `audit_${role}`, password: "audit-role-test-password" } })).body.data.access_token;
    assert.equal((await f.request("/audit-logs", { token })).status, 403);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await f.request("/audit-logs", { method, token: f.token, body: {} })).status, 404);
  assert.equal((await f.request("/audit-logs?action=ACCESS_DENIED&result=DENIED", { token: f.token })).body.meta.total, 2);
  await assert.rejects(f.pool.query("DELETE FROM audit_logs"), { code: "42501" });
  await assert.rejects(f.owner.query("TRUNCATE audit_logs"), { code: "42501" });
});

test("audit redacts nested secret fields before storing and returns safe curated metadata", async (t) => {
  const f = await iotFixture(t);
  await writeAudit(f.pool, { action: "REDACTION_CHECK", targetType: "TEST", details: { safe: "kept", password: "do-not-store-password", nested: [{ authorization: "Bearer do-not-store", credential_hash: "do-not-store-hash", name: "allowed" }] } });
  const row = (await f.pool.query("SELECT details FROM audit_logs WHERE action='REDACTION_CHECK'")).rows[0];
  assert.equal(row.details.password, "[REDACTED]"); assert.equal(row.details.nested[0].authorization, "[REDACTED]");
  assert.equal(JSON.stringify(row).includes("do-not-store"), false);
  const result = await f.request("/audit-logs?action=REDACTION_CHECK", { token: f.token });
  assert.equal(result.body.data[0].details.safe, "kept"); assert.equal(result.body.data[0].details.nested[0].name, "allowed");
});

test("lifecycle history filters transitions/actors/time and preserves room scope and append-only records", async (t) => {
  const f = await iotFixture(t);
  const node = await f.activateSensor();
  await f.action(node.device.device_id, "maintenance");
  const result = await f.request(`/devices/${node.device.device_id}/lifecycle-events?from_status=ACTIVE&to_status=MAINTENANCE&actor_type=USER`, { token: f.token });
  assert.equal(result.status, 200); assert.equal(result.body.meta.total, 1);
  assert.equal(result.body.data[0].reason, "Integration test"); assert.ok(result.body.data[0].actor_id);
  assert.equal((await f.request(`/devices/${node.device.device_id}/lifecycle-events?to_status=BAD`, { token: f.token })).status, 400);
  await assert.rejects(f.pool.query("DELETE FROM device_lifecycle_events"), { code: "42501" });
  await assert.rejects(f.owner.query("UPDATE device_lifecycle_events SET reason='tampered'"), { code: "42501" });
});
