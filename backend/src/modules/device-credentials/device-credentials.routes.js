import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { authorize } from "../../common/authorization.js";
import { idSchema, parse } from "../../common/validation.js";

const actionSchema = z.object({ reason: z.string().trim().min(3).max(255), confirmed: z.boolean().optional() }).strict();
export function createDeviceCredentialsRoutes(pool, service) {
  const router = Router();
  const available = (_req, _res, next) => { if (!service) throw new AppError("BROKER_UNAVAILABLE", 503, "MQTT broker chưa được cấu hình"); next(); };
  for (const action of ["provision", "rotate-credentials", "revoke", "activate"]) {
    router.post(`/devices/:id/${action}`, authorize(pool, "devices:write"), available, async (req, res) => {
      const id = parse(idSchema, req.params.id);
      const input = parse(actionSchema, req.body);
      let data;
      if (action === "activate") data = await service.activate(req.user, id, input, req.requestId);
      else if (action === "revoke") data = await service.revoke(req.user, id, input, req.requestId);
      else data = await service.issue(req.user, id, action === "provision" ? "PROVISION" : "ROTATE", input, req.requestId);
      res.status(data.operation?.status === "PENDING" ? 202 : 200).json({ success: true, data });
    });
  }
  router.get("/devices/:id/broker-status", authorize(pool, "devices:read"), available, async (req, res) => res.json({ success: true, data: await service.status(req.user, parse(idSchema, req.params.id)) }));
  return router;
}
