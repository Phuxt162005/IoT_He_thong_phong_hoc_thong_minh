import { Router } from "express";
import { AuthService } from "./modules/auth/auth.service.js";
import { authenticate, createAuthRoutes } from "./modules/auth/auth.routes.js";
import { apiRateLimit } from "./common/authorization.js";
import { createUsersRoutes } from "./modules/users/users.routes.js";
import { createRoomsRoutes } from "./modules/rooms/rooms.routes.js";
import { createDevicesRoutes } from "./modules/devices/devices.routes.js";

export function createRoutes({ pool, config }) {
  const router = Router();
  const auth = new AuthService({ pool, jwtSecret: config.jwtSecret, jwtExpiresIn: config.jwtExpiresIn });
  router.use(createAuthRoutes(auth));
  router.use(authenticate(auth), apiRateLimit(pool), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(createUsersRoutes(pool));
  router.use(createRoomsRoutes(pool));
  router.use(createDevicesRoutes(pool));
  return router;
}
