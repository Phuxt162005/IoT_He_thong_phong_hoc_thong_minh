import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { UsersService } from "./users.service.js";

const role = z.enum(["ADMIN", "OPERATOR", "VIEWER"]);
const status = z.enum(["ACTIVE", "DISABLED"]);
const displayName = z.string().trim().min(1).max(100);
const createSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/), password: z.string().min(12).max(128), display_name: displayName, role }).strict();
const patchSchema = z.object({ display_name: displayName.optional(), role: role.optional(), status: status.optional() }).strict().refine((v) => Object.keys(v).length > 0);
const listSchema = z.object({ ...pagination, role: role.optional(), status: status.optional() }).strict();

export function createUsersRoutes(pool) {
  const router = Router();
  const users = new UsersService(pool);
  router.get("/users", authorize(pool, "users:read"), async (req, res) => res.json({ success: true, ...await users.list(parse(listSchema, req.query)) }));
  router.get("/users/:id", authorize(pool, "users:read"), async (req, res) => res.json({ success: true, data: await users.get(parse(idSchema, req.params.id)) }));
  router.post("/users", authorize(pool, "users:write"), async (req, res) => res.status(201).json({ success: true, data: await users.create(req.user, parse(createSchema, req.body), req.requestId) }));
  router.patch("/users/:id", authorize(pool, "users:write"), async (req, res) => res.json({ success: true, data: await users.update(req.user, parse(idSchema, req.params.id), parse(patchSchema, req.body), req.requestId) }));
  return router;
}
