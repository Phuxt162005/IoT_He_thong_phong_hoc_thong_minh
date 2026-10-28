import "dotenv/config";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { LoggingService } from "./modules/monitoring-logging/logging.service.js";
import { ConsoleLogSink } from "./modules/monitoring-logging/logging.sinks.js";
import { createPool } from "./database/pool.js";
import { createRoutes } from "./routes.js";
import { MqttRuntime } from "./mqtt/runtime.js";
import { DynamicSecurity } from "./mqtt/dynamic-security.js";
import { DeviceCredentialsService } from "./modules/device-credentials/device-credentials.service.js";
import { TelemetryPipeline, bindTelemetry } from "./modules/telemetry-ingestion/telemetry-pipeline.js";

const logger = new LoggingService({ sink: new ConsoleLogSink() });
try {
  const config = loadConfig(process.env, { requireDatabase: true, requireAuth: true, requireBroker: true });
  const pool = createPool(config.databaseUrl);
  pool.on("error", () => logger.error("database.pool_error"));
  const mqtt = new MqttRuntime({ config, pool, logger });
  const admin = new DynamicSecurity({ url: config.mqttUrl, username: config.mqttAdminUsername, password: config.mqttAdminPassword });
  const credentials = new DeviceCredentialsService({ pool, admin, secretKey: config.deviceSecretKey, mqttUrl: config.mqttUrl, reservedUsernames: [config.mqttUsername, config.mqttAdminUsername] });
  const telemetry = new TelemetryPipeline({ pool, mqtt, logger, freshnessSeconds: config.telemetryFreshnessSeconds });
  const unbindTelemetry = bindTelemetry(mqtt, telemetry);
  let pending = null;
  const reconcile = setInterval(() => {
    if (pending) return;
    pending = credentials.processPending().catch((error) => logger.warn("broker.reconcile_failed", { code: error.code ?? "DATABASE_ERROR" })).finally(() => { pending = null; });
  }, 2000);
  reconcile.unref();
  const cleanup = async () => { clearInterval(reconcile); await pending; await mqtt.stop(); unbindTelemetry(); await pool.end(); };
  const ready = async () => { await pool.query("SELECT 1"); return mqtt.ready; };
  const server = createServer(createApp({ config, logger, ready, routes: createRoutes({ pool, config, credentials }) }));
  server.on("error", async () => { logger.error("server.listen_failed"); process.exitCode = 1; await cleanup(); });
  server.listen(config.port, config.host, () => logger.info("server.started", { host: config.host, port: config.port }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping");
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 10000);
    timeout.unref();
    server.close(async () => { await cleanup(); clearTimeout(timeout); logger.info("server.stopped"); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  logger.error("server.configuration_invalid");
  process.exitCode = 1;
}
