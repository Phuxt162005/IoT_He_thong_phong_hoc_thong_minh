import "dotenv/config";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { LoggingService } from "./modules/monitoring-logging/logging.service.js";
import { ConsoleLogSink } from "./modules/monitoring-logging/logging.sinks.js";
import { createPool } from "./database/pool.js";

const logger = new LoggingService({ sink: new ConsoleLogSink() });
try {
  const config = loadConfig(process.env, { requireDatabase: true });
  const pool = createPool(config.databaseUrl);
  pool.on("error", () => logger.error("database.pool_error"));
  const ready = async () => { await pool.query("SELECT 1"); return true; };
  const server = createServer(createApp({ config, logger, ready }));
  server.on("error", async () => { logger.error("server.listen_failed"); process.exitCode = 1; await pool.end(); });
  server.listen(config.port, config.host, () => logger.info("server.started", { host: config.host, port: config.port }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping");
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 10000);
    timeout.unref();
    server.close(async () => { await pool.end(); clearTimeout(timeout); logger.info("server.stopped"); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  logger.error("server.configuration_invalid");
  process.exitCode = 1;
}
