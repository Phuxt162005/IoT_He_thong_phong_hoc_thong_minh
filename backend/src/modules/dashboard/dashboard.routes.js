import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { DashboardService } from "./dashboard.service.js";

const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const rangeFields = { from: time.optional(), to: time.optional() };
function range(schema, input) {
  const value = parse(schema, input);
  value.to ??= new Date(); value.from ??= new Date(value.to.getTime() - 86400000);
  return parse(z.object({ from: z.date(), to: z.date() }).passthrough().refine((r) => r.from < r.to && r.to - r.from <= 31 * 86400000), value);
}
export function createDashboardRoutes(pool, { freshnessSeconds = 30 } = {}) {
  const router = Router();
  const service = new DashboardService({ pool, freshnessSeconds });
  const query = z.object({ ...pagination, ...rangeFields, device_id: idSchema.optional() }).strict();
  router.get("/dashboard", authorize(pool, "dashboard:read"), async (req, res) => res.json({ success: true, data: await service.dashboard(req.user, parse(z.object({ room_id: idSchema.optional() }).strict(), req.query).room_id) }));
  router.get("/rooms/:id/telemetry/latest", authorize(pool, "telemetry:read"), async (req, res) => res.json({ success: true, ...await service.latest(req.user, parse(idSchema, req.params.id), parse(z.object(pagination).strict(), req.query)) }));
  router.get("/rooms/:id/telemetry/stats", authorize(pool, "telemetry:read"), async (req, res) => res.json({ success: true, data: await service.stats(req.user, parse(idSchema, req.params.id), range(z.object({ ...rangeFields, bucket: z.enum(["hour", "day"]).default("hour") }).strict(), req.query)) }));
  router.get("/rooms/:id/telemetry/export", authorize(pool, "telemetry:read"), async (req, res) => {
    const input = range(z.object({ ...rangeFields, device_id: idSchema.optional() }).strict(), req.query);
    const data = await service.history(req.user, { roomId: parse(idSchema, req.params.id), deviceId: input.device_id }, input, { csv: true });
    res.set("Content-Disposition", 'attachment; filename="telemetry.csv"').type("text/csv").send(data);
  });
  for (const kind of ["rooms", "devices"]) router.get(`/${kind}/:id/telemetry`, authorize(pool, "telemetry:read"), async (req, res) => {
    const input = range(query, req.query);
    const id = parse(idSchema, req.params.id);
    if (kind === "devices" && input.device_id && input.device_id !== id) return res.status(400).json({ success: false, error: { code: "INVALID_FILTER", message: "Bộ lọc thiết bị không khớp" }, request_id: req.requestId });
    res.json({ success: true, ...await service.history(req.user, kind === "rooms" ? { roomId: id, deviceId: input.device_id } : { deviceId: id }, input) });
  });
  return router;
}
