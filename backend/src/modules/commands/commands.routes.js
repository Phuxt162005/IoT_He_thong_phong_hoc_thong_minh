import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { desiredPatchSchema } from "./command-schemas.js";

const createSchema = z.object({ desired_state: desiredPatchSchema, timeout_seconds: z.number().int().min(3).max(10).optional() }).strict();
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export function createCommandsRoutes(pool, commands) {
  const router = Router();
  const available = (_req, _res, next) => { if (!commands) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT chưa được cấu hình"); next(); };
  router.post("/devices/:id/commands", authorize(pool, "commands:create"), available, async (req, res) => {
    const key = req.get("Idempotency-Key");
    const result = await commands.createManual(req.user, parse(idSchema, req.params.id), parse(createSchema, req.body), { idempotencyKey: key === undefined ? undefined : parse(keySchema, key), requestId: req.requestId });
    res.status(result.cached ? 200 : 202).json({ success: true, data: result });
  });
  router.get("/devices/:id/commands", authorize(pool, "commands:read"), available, async (req, res) => res.json({ success: true, ...await commands.list(req.user, parse(idSchema, req.params.id), parse(z.object(pagination).strict(), req.query)) }));
  router.get("/devices/:id/shadow", authorize(pool, "commands:read"), available, async (req, res) => res.json({ success: true, data: await commands.getShadow(req.user, parse(idSchema, req.params.id)) }));
  return router;
}
