import { Router } from "express";
import { AuthService } from "./modules/auth/auth.service.js";
import { authenticate, createAuthRoutes } from "./modules/auth/auth.routes.js";
import { apiRateLimit } from "./common/authorization.js";
import { createUsersRoutes } from "./modules/users/users.routes.js";
import { createRoomsRoutes } from "./modules/rooms/rooms.routes.js";
import { createDevicesRoutes } from "./modules/devices/devices.routes.js";
import { createDeviceCredentialsRoutes } from "./modules/device-credentials/device-credentials.routes.js";
import { createCommandsRoutes } from "./modules/commands/commands.routes.js";
import { createDeviceConfigRoutes } from "./modules/device-config/device-config.routes.js";
import { createAlertsRoutes } from "./modules/alerts/alerts.routes.js";
import { createAutomationRoutes } from "./modules/automation/automation.routes.js";
import { createDashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { createAuditRoutes } from "./modules/audit/audit.routes.js";

export function createRoutes({ pool, config, credentials, commands, configs, alerts, automation }) {
  const router = Router();
  const auth = new AuthService({ pool, jwtSecret: config.jwtSecret, jwtExpiresIn: config.jwtExpiresIn });
  // Đặt các route xác thực trước; /auth/login là điểm vào không cần JWT.
  router.use(createAuthRoutes(auth));
  // Tất cả module phía sau cần phiên hợp lệ, giới hạn tần suất và không được cache phản hồi.
  router.use(authenticate(auth), apiRateLimit(pool), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(createUsersRoutes(pool));
  router.use(createRoomsRoutes(pool));
  router.use(createDevicesRoutes(pool, { heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds }));
  router.use(createDeviceCredentialsRoutes(pool, credentials));
  router.use(createCommandsRoutes(pool, commands));
  router.use(createDeviceConfigRoutes(pool, configs));
  router.use(createAlertsRoutes(pool, alerts));
  router.use(createAutomationRoutes(pool, automation));
  router.use(createDashboardRoutes(pool, { freshnessSeconds: config.telemetryFreshnessSeconds }));
  router.use(createAuditRoutes(pool));
  return router;
}
