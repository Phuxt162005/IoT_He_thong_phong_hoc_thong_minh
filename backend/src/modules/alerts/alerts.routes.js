import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { AlertsService } from "./alerts.service.js";

const status = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
const severity = z.enum(["WARNING", "CRITICAL"]);
const listSchema = z.object({ ...pagination, room_id: idSchema.optional(), status: status.optional(), severity: severity.optional(), alert_type: z.enum(["TEMP_HIGH", "HUMIDITY_HIGH", "DEVICE_OFFLINE", "DEVICE_FAULT"]).optional() }).strict();
const threshold = z.object({ sensor_type: z.enum(["TEMPERATURE", "HUMIDITY"]), severity, operator: z.enum(["GT", "GTE"]), threshold_value: z.number().finite(), clear_value: z.number().finite(), is_enabled: z.boolean() }).strict();
const thresholdsSchema = z.object({ thresholds: z.array(threshold).min(1).max(4).refine((rows) => new Set(rows.map((r) => `${r.sensor_type}:${r.severity}`)).size === rows.length) }).strict();

export function createAlertsRoutes(pool, service = new AlertsService({ pool })) {
  const router = Router();
  router.get("/alerts", authorize(pool, "alerts:read"), async (req, res) => res.json({ success: true, ...await service.list(req.user, parse(listSchema, req.query)) }));
  router.get("/alerts/:id", authorize(pool, "alerts:read"), async (req, res) => res.json({ success: true, data: await service.get(req.user, parse(idSchema, req.params.id)) }));
  router.post("/alerts/:id/acknowledge", authorize(pool, "alerts:write"), async (req, res) => {
    parse(z.object({}).strict(), req.body ?? {});
    res.json({ success: true, data: await service.act(req.user, parse(idSchema, req.params.id), "acknowledge", null, req.requestId) });
  });
  router.post("/alerts/:id/resolve", authorize(pool, "alerts:write"), async (req, res) => {
    const input = parse(z.object({ reason: z.string().trim().min(3).max(255) }).strict(), req.body);
    res.json({ success: true, data: await service.act(req.user, parse(idSchema, req.params.id), "resolve", input.reason, req.requestId) });
  });
  router.get("/rooms/:id/alert-thresholds", authorize(pool, "thresholds:read"), async (req, res) => res.json({ success: true, data: await service.getThresholds(req.user, parse(idSchema, req.params.id)) }));
  router.put("/rooms/:id/alert-thresholds", authorize(pool, "thresholds:write"), async (req, res) => res.json({ success: true, data: await service.updateThresholds(req.user, parse(idSchema, req.params.id), parse(thresholdsSchema, req.body).thresholds, req.requestId) }));
  return router;
}
