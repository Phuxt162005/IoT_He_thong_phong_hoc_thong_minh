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
import { DevicePresenceService, bindPresence } from "./modules/device-presence/device-presence.service.js";
import { startJob } from "./common/scheduler.js";
import { CommandsService, bindCommands } from "./modules/commands/commands.service.js";
import { DeviceConfigService, bindDeviceConfig } from "./modules/device-config/device-config.service.js";
import { AlertsService } from "./modules/alerts/alerts.service.js";
import { AutomationService } from "./modules/automation/automation.service.js";
import { attachRealtime } from "./modules/realtime/realtime.js";
import { expectedSchemaVersion, schemaReady } from "./database/readiness.js";
import { runRetention } from "./database/retention.js";

const logger = new LoggingService({ sink: new ConsoleLogSink() });
try {
  // Khởi tạo dependency dùng chung: pool database, MQTT runtime và các service nghiệp vụ.
  const config = loadConfig(process.env, { requireDatabase: true, requireAuth: true, requireBroker: true });
  const pool = createPool(config.databaseUrl);
  const schemaVersion = await expectedSchemaVersion();
  pool.on("error", () => logger.error("database.pool_error"));
  const mqtt = new MqttRuntime({ config, pool, logger });
  const admin = new DynamicSecurity({ url: config.mqttUrl, username: config.mqttAdminUsername, password: config.mqttAdminPassword });
  const credentials = new DeviceCredentialsService({ pool, admin, secretKey: config.deviceSecretKey, mqttUrl: config.mqttUrl, reservedUsernames: [config.mqttUsername, config.mqttAdminUsername], heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds });
  const presence = new DevicePresenceService({ pool, timeoutSeconds: config.heartbeatTimeoutSeconds });
  const unbindPresence = bindPresence(mqtt, presence);
  const commands = new CommandsService({ pool, mqtt, logger, timeoutSeconds: config.commandTimeoutSeconds, heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds, manualOverrideSeconds: config.manualOverrideSeconds });
  const unbindCommands = bindCommands(mqtt, commands);
  const configs = new DeviceConfigService({ pool, mqtt, timeoutSeconds: config.configTimeoutSeconds, heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds });
  const unbindConfigs = bindDeviceConfig(mqtt, configs);
  const alerts = new AlertsService({ pool, freshnessSeconds: config.telemetryFreshnessSeconds });
  const automation = new AutomationService({ pool, commands, freshnessSeconds: config.telemetryFreshnessSeconds, heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds });
  const telemetry = new TelemetryPipeline({ pool, mqtt, logger, freshnessSeconds: config.telemetryFreshnessSeconds });
  const unbindTelemetry = bindTelemetry(mqtt, telemetry);
  // Job nền khôi phục yêu cầu chờ, giám sát kết nối/cảnh báo và đánh giá rule tự động.
  const reconcile = startJob("broker-reconcile", () => credentials.processPending(), { intervalMs: 2000, logger });
  const offlineScan = startJob("offline-scan", () => presence.scanOffline(), { intervalMs: 5000, logger });
  const commandRecovery = startJob("command-recovery", async () => { await commands.expirePending(); await commands.processPending(); }, { intervalMs: 1000, logger });
  const configRecovery = startJob("config-recovery", async () => { await configs.expirePending(); await configs.processPending(); }, { intervalMs: 1000, logger });
  const alertMonitor = startJob("alert-monitor", async () => { await alerts.consumeTelemetry(); await alerts.scanDevices(); }, { intervalMs: 1000, logger });
  const automationMonitor = startJob("automation-monitor", () => automation.tick(), { intervalMs: 1000, logger });
  const retention = config.retentionEnabled ? startJob("retention", () => runRetention(pool, { sensorDays: config.sensorRetentionDays, eventDays: config.eventRetentionDays }), { intervalMs: 3600000, logger }) : null;
  let cleaning;
  // Ghi nhớ promise dọn dẹp để tín hiệu dừng/lỗi server không đóng tài nguyên nhiều lần.
  // Chờ job kết thúc trước khi đóng MQTT và pool, vì job có thể còn dùng hai dependency này.
  const cleanup = () => cleaning ??= (async () => { await realtime.stop(); await Promise.all([reconcile.stop(), offlineScan.stop(), commandRecovery.stop(), configRecovery.stop(), alertMonitor.stop(), automationMonitor.stop(), retention?.stop()]); await mqtt.stop(); unbindPresence(); unbindCommands(); unbindConfigs(); unbindTelemetry(); await pool.end(); })();
  const ready = async () => await schemaReady(pool, schemaVersion) && mqtt.ready && realtime.ready();
  const server = createServer(createApp({ config, logger, ready, routes: createRoutes({ pool, config, credentials, commands, configs, alerts, automation }) }));
  const realtime = attachRealtime({ server, pool, config, logger });
  server.on("error", async () => { logger.error("server.listen_failed"); process.exitCode = 1; await cleanup(); });
  server.listen(config.port, config.host, () => logger.info("server.started", { host: config.host, port: config.port }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping");
    void realtime.stop().catch(() => logger.error("realtime.stop_failed"));
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 10000);
    timeout.unref();
    // Ngừng nhận HTTP mới, đợi request hiện tại kết thúc rồi mới giải phóng dependency.
    server.close(async () => { await cleanup(); clearTimeout(timeout); logger.info("server.stopped"); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  logger.error("server.configuration_invalid");
  process.exitCode = 1;
}
