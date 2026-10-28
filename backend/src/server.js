import "dotenv/config";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { LoggingService } from "./modules/monitoring-logging/logging.service.js";
import { ConsoleLogSink } from "./modules/monitoring-logging/logging.sinks.js";

const logger = new LoggingService({ sink: new ConsoleLogSink() });
try {
  const config = loadConfig();
  const server = createServer(createApp({ config, logger }));
  server.on("error", () => { logger.error("server.listen_failed"); process.exitCode = 1; });
  server.listen(config.port, config.host, () => logger.info("server.started", { host: config.host, port: config.port }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping");
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 10000);
    timeout.unref();
    server.close(() => { clearTimeout(timeout); logger.info("server.stopped"); });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  logger.error("server.configuration_invalid");
  process.exitCode = 1;
}
