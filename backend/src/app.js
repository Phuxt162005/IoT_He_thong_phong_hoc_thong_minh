import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { AppError } from "./common/errors.js";
import { LoggingService } from "./modules/monitoring-logging/logging.service.js";
import { ConsoleLogSink } from "./modules/monitoring-logging/logging.sinks.js";

export function createApp({ config, logger = new LoggingService({ sink: new ConsoleLogSink() }), ready = async () => true, routes } = {}) {
  if (!config) throw new TypeError("Cần cấu hình ứng dụng");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incoming = req.get("X-Request-Id");
    req.requestId = typeof incoming === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.set("X-Request-Id", req.requestId);
    const started = performance.now();
    res.on("finish", () => logger.info("http.request", {
      request_id: req.requestId, method: req.method, status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
      // Không log URL/header/body gốc vì chúng có thể chứa mật khẩu hoặc token.
      route: req.route?.path ?? "unmatched",
    }));
    next();
  });
  app.use(helmet());
  app.use(cors({ origin(origin, callback) { callback(null, !origin || config.corsOrigins.includes(origin)); } }));
  app.use(express.json({ limit: "32kb", strict: true }));
  app.get("/health", (_req, res) => res.json({ success: true, data: { status: "UP" } }));
  app.get("/ready", async (_req, res) => {
    let healthy = false;
    try { healthy = await ready(); } catch { /* Không trả chi tiết lỗi dịch vụ phụ thuộc ra ngoài. */ }
    res.status(healthy ? 200 : 503).json({ success: healthy, data: { status: healthy ? "READY" : "NOT_READY" } });
  });
  if (routes) app.use("/api/v1", routes);
  app.use((_req, _res, next) => next(new AppError("NOT_FOUND", 404, "Không tìm thấy endpoint")));
  app.use((error, req, res, _next) => {
    let status = error instanceof AppError ? error.status : 500;
    let code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    let message = error instanceof AppError ? error.message : "Lỗi hệ thống";
    if (error.type === "entity.parse.failed") { status = 400; code = "INVALID_JSON"; message = "JSON không hợp lệ"; }
    if (error.type === "entity.too.large") { status = 413; code = "PAYLOAD_TOO_LARGE"; message = "Payload vượt giới hạn"; }
    if (error.code === "23505") { status = 409; code = "CONFLICT"; message = "Dữ liệu đã tồn tại hoặc đang được sử dụng"; }
    if (error.code === "23503") { status = 400; code = "INVALID_REFERENCE"; message = "Dữ liệu tham chiếu không hợp lệ"; }
    if (["ECONNREFUSED", "57P01", "53300", "08006"].includes(error.code)) { status = 503; code = "DATABASE_UNAVAILABLE"; message = "Dịch vụ dữ liệu chưa sẵn sàng"; }
    if (["40P01", "40001"].includes(error.code)) { status = 409; code = "TRANSACTION_CONFLICT"; message = "Dữ liệu vừa thay đổi, hãy thử lại"; }
    if (status >= 500) logger.error("http.error", { request_id: req.requestId, code,
      cause_code: typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined });
    res.status(status).json({ success: false, error: { code, message, ...(error instanceof AppError && error.details ? { details: error.details } : {}) }, request_id: req.requestId });
  });
  return app;
}
