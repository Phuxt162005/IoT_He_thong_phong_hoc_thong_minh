import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createApp } from "../../backend/src/app.js";
import { loadConfig } from "../../backend/src/config.js";
import { createRoutes } from "../../backend/src/routes.js";
import { LoggingService } from "../../backend/src/modules/monitoring-logging/logging.service.js";
import { MemoryLogSink } from "../../backend/src/modules/monitoring-logging/logging.sinks.js";

export async function testHttp(t, pool, { config = loadConfig({ JWT_SECRET: randomBytes(48).toString("hex") }), credentials, commands, configs, alerts, automation, ota, firmwareStorage, downloadSigner } = {}) {
  const sink = new MemoryLogSink();
  const server = createApp({ config, logger: new LoggingService({ sink }), routes: createRoutes({ pool, config, credentials, commands, configs, alerts, automation, ota, firmwareStorage, downloadSigner }), ready: async () => { await pool.query("SELECT 1"); return true; } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config, sink, base, server,
    async requestRaw(path, { method = "POST", body, token, headers = {} } = {}) {\n      const response = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });\n      const text = await response.text();\n      let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }\n      return { status: response.status, body: parsed, headers: response.headers };\n    },\n    async request(path, { method = "GET", body, token, headers = {} } = {}) {
      const response = await fetch(`${base}/api/v1${path}`, {
        method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
  };
}
