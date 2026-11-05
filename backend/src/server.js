import "dotenv/config";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { LoggingService } from "./modules/monitoring-logging/logging.service.js";
import { ConsoleLogSink } from "./modules/monitoring-logging/logging.sinks.js";
import { PostgresMonitoringRepository } from "./modules/monitoring-logging/monitoring.repository.postgres.js";
import {
  MonitoringService,
  bindMonitoring,
} from "./modules/monitoring-logging/monitoring.service.js";
import { createPool } from "./database/pool.js";
import { createRoutes } from "./routes.js";
import { MqttRuntime } from "./mqtt/runtime.js";
import { DynamicSecurity } from "./mqtt/dynamic-security.js";
import { DeviceCredentialsService } from "./modules/device-credentials/device-credentials.service.js";
import {
  TelemetryPipeline,
  bindTelemetry,
} from "./modules/telemetry-ingestion/telemetry-pipeline.js";
import {
  DevicePresenceService,
  bindPresence,
} from "./modules/device-presence/device-presence.service.js";
import { startJob } from "./common/scheduler.js";
import {
  CommandsService,
  bindCommands,
} from "./modules/commands/commands.service.js";
import {
  DeviceConfigService,
  bindDeviceConfig,
} from "./modules/device-config/device-config.service.js";
import { AlertsService } from "./modules/alerts/alerts.service.js";
import { AutomationService } from "./modules/automation/automation.service.js";
import { attachRealtime } from "./modules/realtime/realtime.js";
import { expectedSchemaVersion, schemaReady } from "./database/readiness.js";
import { runRetention } from "./database/retention.js";
import { AnomalyDetectionConsumer } from "./modules/anomaly-detection/anomaly-detection.consumer.js";
import { OtaRepository } from "./modules/ota/ota.repository.pg.js";
import { OtaService, bindOta } from "./modules/ota/ota.service.js";
import { LocalFirmwareStorage } from "./modules/ota/ota.storage.js";
import { OtaDownloadSigner } from "./modules/ota/ota.download-signer.js";

const logger = new LoggingService({ sink: new ConsoleLogSink() });

try {
  const config = loadConfig(process.env, {
    requireDatabase: true,
    requireAuth: true,
    requireBroker: true,
    requireOta: true,
  });
  const pool = createPool(config.databaseUrl);
  const schemaVersion = await expectedSchemaVersion();

  pool.on("error", () => logger.error("database.pool_error"));

  const mqtt = new MqttRuntime({ config, pool, logger });
  const otaRepository = new OtaRepository(pool);

  const firmwareStorage = new LocalFirmwareStorage({
    directory: config.otaStorageDirectory,
  });

  const downloadSigner = new OtaDownloadSigner({
    baseUrl: config.otaDownloadBaseUrl,
    secret: config.otaDownloadSecret,
  });

  await firmwareStorage.ensureDirectory();

  const ota = new OtaService({
    pool,
    repository: otaRepository,
    mqtt,
    storage: firmwareStorage,
    downloadUrlSigner: downloadSigner,
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
    timeoutSeconds: config.otaTimeoutSeconds,
    downloadUrlLifetimeSeconds: config.otaDownloadUrlLifetimeSeconds,
    firmwareSigningPrivateKeyB64: config.otaSigningPrivateKeyB64,
  });

  const unbindOta = bindOta(mqtt, ota);
  const otaRecovery = startJob(
    "ota-recovery",
    async () => {
      await ota.expirePending();
      await ota.processPending();
    },
    { intervalMs: 2000, logger },
  );
  const admin = new DynamicSecurity({
    url: config.mqttUrl,
    username: config.mqttAdminUsername,
    password: config.mqttAdminPassword,
  });

  const credentials = new DeviceCredentialsService({
    pool,
    admin,
    secretKey: config.deviceSecretKey,
    mqttUrl: config.mqttUrl,
    reservedUsernames: [config.mqttUsername, config.mqttAdminUsername],
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
  });

  const monitoringRepository = new PostgresMonitoringRepository(pool);
  const monitoring = new MonitoringService({
    repository: monitoringRepository,
    logger,
    offlineAfterMs: config.heartbeatTimeoutSeconds * 1000,
  });

  const presence = new DevicePresenceService({
    pool,
    timeoutSeconds: config.heartbeatTimeoutSeconds,
  });
  const unbindPresence = bindPresence(mqtt, presence);
  const unbindMonitoring = bindMonitoring(mqtt, monitoring);

  const commands = new CommandsService({
    pool,
    mqtt,
    logger,
    timeoutSeconds: config.commandTimeoutSeconds,
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
    manualOverrideSeconds: config.manualOverrideSeconds,
  });
  const unbindCommands = bindCommands(mqtt, commands);

  const configs = new DeviceConfigService({
    pool,
    mqtt,
    timeoutSeconds: config.configTimeoutSeconds,
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
  });
  const unbindConfigs = bindDeviceConfig(mqtt, configs);

  const alerts = new AlertsService({
    pool,
    freshnessSeconds: config.telemetryFreshnessSeconds,
  });
  const automation = new AutomationService({
    pool,
    commands,
    freshnessSeconds: config.telemetryFreshnessSeconds,
    heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
  });

  const telemetry = new TelemetryPipeline({
    pool,
    mqtt,
    logger,
    freshnessSeconds: config.telemetryFreshnessSeconds,
  });
  const anomalyDetection = new AnomalyDetectionConsumer({ pool, logger });
  const unbindTelemetry = bindTelemetry(mqtt, telemetry);

  const reconcile = startJob(
    "broker-reconcile",
    () => credentials.processPending(),
    { intervalMs: 2000, logger },
  );
  const offlineScan = startJob("offline-scan", () => presence.scanOffline(), {
    intervalMs: 5000,
    logger,
  });
  const commandRecovery = startJob(
    "command-recovery",
    async () => {
      await commands.expirePending();
      await commands.processPending();
    },
    { intervalMs: 1000, logger },
  );
  const configRecovery = startJob(
    "config-recovery",
    async () => {
      await configs.expirePending();
      await configs.processPending();
    },
    { intervalMs: 1000, logger },
  );
  const alertMonitor = startJob(
    "alert-monitor",
    async () => {
      await alerts.consumeTelemetry();
      await alerts.scanDevices();
    },
    { intervalMs: 1000, logger },
  );
  const automationMonitor = startJob(
    "automation-monitor",
    () => automation.tick(),
    { intervalMs: 1000, logger },
  );
  const retention = config.retentionEnabled
    ? startJob(
        "retention",
        () =>
          runRetention(pool, {
            sensorDays: config.sensorRetentionDays,
            eventDays: config.eventRetentionDays,
          }),
        { intervalMs: 3600000, logger },
      )
    : null;

  const anomalyMonitor = startJob(
    "anomaly-detection",
    () => anomalyDetection.consumePending(),
    { intervalMs: 2000, logger },
  );

  const server = createServer();
  const realtime = attachRealtime({ server, pool, config, logger });

  const monitoringScan = startJob(
    "monitoring-scan",
    async () => {
      const update = async (name, status, details = {}) => {
        try {
          await monitoring.setComponentStatus(name, status, details);
        } catch (error) {
          logger.warn("monitoring.component_update_failed", {
            component: name,
            code: error.code ?? "MONITORING_ERROR",
          });
        }
      };

      await update("backend", "UP", { process: "running" });

      let databaseStatus = "DOWN";
      try {
        await pool.query("SELECT 1");
        databaseStatus = "UP";
      } catch {
        logger.warn("monitoring.database_check_failed");
      }

      await update("postgresql", databaseStatus);
      await update("mqtt-broker", mqtt.ready ? "UP" : "DOWN");
      await update("realtime-websocket", realtime.ready() ? "UP" : "DOWN");
    },
    { intervalMs: 10000, logger },
  );

  let cleaning;
  const cleanup = () =>
    (cleaning ??= (async () => {
      await realtime.stop();
      await Promise.all([
        otaRecovery.stop(),
        reconcile.stop(),
        offlineScan.stop(),
        commandRecovery.stop(),
        configRecovery.stop(),
        alertMonitor.stop(),
        automationMonitor.stop(),
        monitoringScan.stop(),
        retention?.stop(),
        anomalyMonitor.stop(),
      ]);
      await mqtt.stop();
      unbindPresence();
      unbindMonitoring();
      unbindCommands();
      unbindConfigs();
      unbindTelemetry();
      unbindOta();
      await pool.end();
    })());

  const ready = async () =>
    (await schemaReady(pool, schemaVersion)) && mqtt.ready && realtime.ready();
  const app = createApp({
    config,
    logger,
    ready,
    routes: createRoutes({
      pool,
      config,
      ota,
      firmwareStorage,
      downloadSigner,
      credentials,
      commands,
      configs,
      alerts,
      automation,
    }),
  });

  server.on("request", app);
  server.on("error", async () => {
    logger.error("server.listen_failed");
    process.exitCode = 1;
    await cleanup();
  });

  server.listen(config.port, config.host, () => {
    logger.info("server.started", { host: config.host, port: config.port });
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping");
    void realtime.stop().catch(() => logger.error("realtime.stop_failed"));

    const timeout = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 10000);
    timeout.unref();

    server.close(async () => {
      await cleanup();
      clearTimeout(timeout);
      logger.info("server.stopped");
    });
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  logger.error("server.configuration_invalid");
  process.exitCode = 1;
}
