import { Router } from "express";
import { AuthService } from "./modules/auth/auth.service.js";
import { createAuthRoutes } from "./modules/auth/auth.routes.js";

export function createRoutes({ pool, config }) {
  const router = Router();
  const auth = new AuthService({ pool, jwtSecret: config.jwtSecret, jwtExpiresIn: config.jwtExpiresIn });
  router.use(createAuthRoutes(auth));
  return router;
}
