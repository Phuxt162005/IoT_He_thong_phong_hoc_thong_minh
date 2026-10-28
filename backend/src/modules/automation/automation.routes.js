import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { AutomationService } from "./automation.service.js";
import { validCondition } from "./conditions.js";

const fields = {
  name: z.string().trim().min(1).max(100), target_device_id: idSchema,
  actuator: z.enum(["LIGHT", "FAN"]), action: z.enum(["ON", "OFF"]), condition: z.unknown().refine(validCondition),
  hold_seconds: z.number().int().min(0).max(300), cooldown_seconds: z.number().int().min(1).max(3600),
  priority: z.number().int().min(1).max(1000), is_enabled: z.boolean(),
};
const createSchema = z.object(fields).strict();
const patchSchema = createSchema.partial().refine((value) => Object.keys(value).length > 0);
export function createAutomationRoutes(pool, service = new AutomationService({ pool })) {
  const router = Router();
  router.get("/rooms/:id/automation-rules", authorize(pool, "rules:read"), async (req, res) => res.json({ success: true, ...await service.list(req.user, parse(idSchema, req.params.id), parse(z.object(pagination).strict(), req.query)) }));
  router.post("/rooms/:id/automation-rules", authorize(pool, "rules:write"), async (req, res) => res.status(201).json({ success: true, data: await service.save(req.user, { roomId: parse(idSchema, req.params.id), input: parse(createSchema, req.body), requestId: req.requestId }) }));
  router.patch("/automation-rules/:id", authorize(pool, "rules:write"), async (req, res) => res.json({ success: true, data: await service.save(req.user, { ruleId: parse(idSchema, req.params.id), input: parse(patchSchema, req.body), requestId: req.requestId }) }));
  router.put("/devices/:id/control-mode", authorize(pool, "commands:create"), async (req, res) => res.json({ success: true, data: await service.setMode(req.user, parse(idSchema, req.params.id), parse(z.object({ control_mode: z.enum(["AUTO", "MANUAL"]), reason: z.string().trim().min(3).max(255) }).strict(), req.body), req.requestId) }));
  return router;
}
