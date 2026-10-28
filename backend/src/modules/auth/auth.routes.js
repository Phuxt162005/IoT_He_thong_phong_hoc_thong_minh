import { Router } from "express";
import { z } from "zod";
import { parse } from "../../common/validation.js";
import { publicUser } from "./auth.service.js";

const loginSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/), password: z.string().min(1).max(128) }).strict();
const changeSchema = z.object({ current_password: z.string().min(1).max(128), new_password: z.string().min(12).max(128) }).strict().refine((v) => v.current_password !== v.new_password);

export function authenticate(auth) {
  return async (req, _res, next) => { req.user = await auth.authenticate(req.get("Authorization")); next(); };
}

export function createAuthRoutes(auth) {
  const router = Router();
  router.post("/auth/login", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: await auth.login(parse(loginSchema, req.body), { ip: req.ip, requestId: req.requestId }) });
  });
  router.use("/auth", authenticate(auth), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/auth/me", (req, res) => res.json({ success: true, data: publicUser(req.user) }));
  router.post("/auth/logout", async (req, res) => {
    await auth.logout(req.user, req.requestId);
    res.json({ success: true, data: { logged_out: true } });
  });
  router.post("/auth/change-password", async (req, res) => {
    await auth.changePassword(req.user, parse(changeSchema, req.body), req.requestId);
    res.json({ success: true, data: { password_changed: true, login_required: true } });
  });
  return router;
}
