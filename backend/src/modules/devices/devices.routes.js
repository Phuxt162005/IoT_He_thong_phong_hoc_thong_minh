import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { DevicesService } from "./devices.service.js";

const name = z.string().trim().min(1).max(100);
const version = z.string().trim().min(1).max(64);
const deviceType = z.enum(["SENSOR_NODE", "CONTROL_NODE"]);
const lifecycleStatus = z.enum(["REGISTERED", "PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE", "REVOKED", "DECOMMISSIONED"]);
const createSchema = z.object({ device_code: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), device_name: name, device_type: deviceType, room_id: idSchema.optional(), hardware_version: version.optional(), firmware_version: version.optional() }).strict();
const patchSchema = z.object({ device_name: name.optional(), room_id: idSchema.nullable().optional(), hardware_version: version.optional(), firmware_version: version.optional() }).strict().refine((v) => Object.keys(v).length > 0);
const listSchema = z.object({ ...pagination, room_id: idSchema.optional(), device_type: deviceType.optional(), lifecycle_status: lifecycleStatus.optional(), connection_status: z.enum(["UNKNOWN", "ONLINE", "OFFLINE"]).optional() }).strict();
const actionSchema = z.object({ reason: z.string().trim().min(3).max(255), confirmed: z.boolean().optional() }).strict();

export function createDevicesRoutes(pool, options) {
  const router = Router();
  const devices = new DevicesService(pool, options);
  router.get("/devices", authorize(pool, "devices:read"), async (req, res) => res.json({ success: true, ...await devices.list(req.user, parse(listSchema, req.query)) }));
  router.get("/devices/:id", authorize(pool, "devices:read"), async (req, res) => res.json({ success: true, data: await devices.get(req.user, parse(idSchema, req.params.id)) }));
  router.post("/devices", authorize(pool, "devices:write"), async (req, res) => res.status(201).json({ success: true, data: await devices.register(req.user, parse(createSchema, req.body), req.requestId) }));
  router.patch("/devices/:id", authorize(pool, "devices:write"), async (req, res) => res.json({ success: true, data: await devices.update(req.user, parse(idSchema, req.params.id), parse(patchSchema, req.body), req.requestId) }));
  for (const action of ["maintenance", "resume", "clear-fault", "recover", "decommission"]) {
    router.post(`/devices/:id/${action}`, authorize(pool, "devices:write"), async (req, res) => res.json({ success: true, data: await devices.lifecycle(req.user, parse(idSchema, req.params.id), action, parse(actionSchema, req.body), req.requestId) }));
  }
  router.get("/devices/:id/lifecycle-events", authorize(pool, "devices:read"), async (req, res) => res.json({ success: true, ...await devices.events(req.user, parse(idSchema, req.params.id), parse(z.object(pagination).strict(), req.query)) }));
  return router;
}
