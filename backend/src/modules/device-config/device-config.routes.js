import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { AppError } from "../../common/errors.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { settingsSchema } from "./device-config.service.js";

export function createDeviceConfigRoutes(pool, configs) {
  const router = Router();
  const available = (_req, _res, next) => { if (!configs) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT chưa được cấu hình"); next(); };
  router.post("/devices/:id/configs", authorize(pool, "configs:write"), available, async (req, res) => {
    const input = parse(z.object({ settings: settingsSchema }).strict(), req.body);
    res.status(202).json({ success: true, data: await configs.create(req.user, parse(idSchema, req.params.id), input.settings, req.requestId) });
  });
  router.get("/devices/:id/configs", authorize(pool, "configs:read"), available, async (req, res) => res.json({ success: true, ...await configs.list(req.user, parse(idSchema, req.params.id), parse(z.object(pagination).strict(), req.query)) }));
  return router;
}
