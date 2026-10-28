import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createApp } from "../backend/src/app.js";
import { loadConfig } from "../backend/src/config.js";
import { LoggingService } from "../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../backend/src/modules/monitoring-logging/logging.sinks.js";

async function fixture(t, options = {}) {
  const sink = new MemoryLogSink();
  const server = createApp({ config: loadConfig({}), logger: new LoggingService({ sink }), ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, sink };
}

test("health, readiness and request correlation work over HTTP", async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/health`, { headers: { "X-Request-Id": "test-123" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "test-123");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal((await response.json()).data.status, "UP");
  assert.equal((await fetch(`${base}/ready`)).status, 200);
});

test("dependency outage is not ready; unexpected errors do not leak details", async (t) => {
  const routes = express.Router();
  routes.get("/fail", () => { throw new Error("password=do-not-leak"); });
  const { base, sink } = await fixture(t, { ready: async () => { throw new Error("db-secret"); }, routes });
  assert.equal((await fetch(`${base}/ready`)).status, 503);
  const response = await fetch(`${base}/api/v1/fail?token=do-not-leak`);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(sink.getEntries()).includes("do-not-leak"));
});

test("malformed JSON, oversized bodies and unknown routes return safe errors", async (t) => {
  const { base } = await fixture(t);
  const malformed = await fetch(`${base}/api/v1/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");
  const large = await fetch(`${base}/api/v1/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(40000) }) });
  assert.equal(large.status, 413);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test("CORS uses allowlist and configuration errors never echo secrets", async (t) => {
  const { base } = await fixture(t);
  const allowed = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:5173" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const denied = await fetch(`${base}/health`, { headers: { Origin: "https://untrusted.invalid" } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.throws(() => loadConfig({ PORT: "secret-password" }), (e) => !e.message.includes("secret-password") && e.message.includes("PORT"));
  assert.throws(() => loadConfig({ CORS_ORIGINS: "*" }), /CORS_ORIGINS/);
});
