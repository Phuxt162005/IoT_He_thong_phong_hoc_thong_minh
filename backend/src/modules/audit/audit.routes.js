import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { sanitizeAuditDetails } from "../../database/audit.js";

const code = (max) => z.string().regex(new RegExp(`^[A-Z0-9_]{1,${max}}$`));
const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const filters = z.object({
  ...pagination, actor_type: z.enum(["USER", "DEVICE", "SYSTEM"]).optional(), actor_id: idSchema.optional(),
  action: code(64).optional(), target_type: code(32).optional(), target_id: z.string().min(1).max(64).optional(),
  result: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(), request_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  from: time.optional(), to: time.optional(),
}).strict();
export function createAuditRoutes(pool) {
  const router = Router();
  router.get("/audit-logs", authorize(pool, "audit:read"), async (req, res) => {
    const input = parse(filters, req.query);
    input.to ??= new Date(); input.from ??= new Date(input.to.getTime() - 7 * 86400000);
    parse(z.object({ from: z.date(), to: z.date() }).refine((v) => v.from < v.to && v.to - v.from <= 90 * 86400000), { from: input.from, to: input.to });
    const params = []; const clauses = [];
    // Tên cột lấy từ danh sách cố định, giá trị đi qua parameter; không ghép SQL từ tên trường client gửi.
    for (const key of ["actor_type", "actor_id", "action", "target_type", "target_id", "result", "request_id"]) if (input[key] !== undefined) { params.push(input[key]); clauses.push(`${key}=$${params.length}`); }
    params.push(input.from, input.to); clauses.push(`created_at >= $${params.length - 1}`, `created_at < $${params.length}`);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = Number((await pool.query(`SELECT count(*) FROM audit_logs ${where}`, params)).rows[0].count);
    const data = (await pool.query(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC,log_id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, input.page_size, (input.page - 1) * input.page_size])).rows.map((row) => ({ ...row, details: sanitizeAuditDetails(row.details) }));
    res.json({ success: true, data, meta: { page: input.page, page_size: input.page_size, total, from: input.from, to: input.to } });
  });
  return router;
}
