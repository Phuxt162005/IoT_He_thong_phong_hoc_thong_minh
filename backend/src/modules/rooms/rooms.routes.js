import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { RoomsService } from "./rooms.service.js";

const roomName = z.string().trim().min(1).max(100);
const status = z.enum(["ACTIVE", "INACTIVE"]);
const listSchema = z.object({ ...pagination, status: status.optional() }).strict();
const createSchema = z.object({ room_code: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), room_name: roomName }).strict();
const patchSchema = z.object({ room_name: roomName.optional(), status: status.optional() }).strict().refine((v) => Object.keys(v).length > 0);
const membersSchema = z.object({ user_ids: z.array(idSchema).max(500).refine((ids) => new Set(ids).size === ids.length) }).strict();

export function createRoomsRoutes(pool) {
  const router = Router();
  const rooms = new RoomsService(pool);
  router.get("/rooms", authorize(pool, "rooms:read"), async (req, res) => res.json({ success: true, ...await rooms.list(req.user, parse(listSchema, req.query)) }));
  router.get("/rooms/:id", authorize(pool, "rooms:read"), async (req, res) => res.json({ success: true, data: await rooms.get(req.user, parse(idSchema, req.params.id)) }));
  router.post("/rooms", authorize(pool, "rooms:write"), async (req, res) => res.status(201).json({ success: true, data: await rooms.create(req.user, parse(createSchema, req.body), req.requestId) }));
  router.patch("/rooms/:id", authorize(pool, "rooms:write"), async (req, res) => res.json({ success: true, data: await rooms.update(req.user, parse(idSchema, req.params.id), parse(patchSchema, req.body), req.requestId) }));
  router.get("/rooms/:id/users", authorize(pool, "rooms:write"), async (req, res) => res.json({ success: true, data: await rooms.members(parse(idSchema, req.params.id)) }));
  router.put("/rooms/:id/users", authorize(pool, "rooms:write"), async (req, res) => res.json({ success: true, data: await rooms.assignUsers(req.user, parse(idSchema, req.params.id), parse(membersSchema, req.body).user_ids, req.requestId) }));
  return router;
}
