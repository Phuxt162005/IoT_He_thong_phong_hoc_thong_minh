import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { pagination, parse } from "../../common/validation.js";
import { AppError } from "../../common/errors.js";

const time = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const snapshotQuery = z.object({}).strict();

const logQuery = z
  .object({
    ...pagination,
    level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
    service: z.string().min(1).max(100).optional(),
    search: z.string().min(1).max(200).optional(),
    from: time.optional(),
    to: time.optional(),
  })
  .strict();

export function createMonitoringRoutes(pool, monitoring) {
  const router = Router();
  if (!monitoring?.repository) {
    throw new AppError(
      "MONITORING_UNAVAILABLE",
      503,
      "Monitoring service chưa được khởi tạo",
    );
  }

  router.get(
    "/monitoring/snapshot",
    authorize(pool, "monitoring:read"),
    async (_req, res) => {
      const data = await monitoring.getSnapshot();

      res.json({
        success: true,
        data,
      });
    },
  );

  router.get(
    "/monitoring/logs",
    authorize(pool, "monitoring:read"),
    async (req, res) => {
      const input = parse(logQuery, req.query);
      input.to ??= new Date();
      input.from ??= new Date(input.to.getTime() - 24 * 60 * 60 * 1000);

      if (
        input.from >= input.to ||
        input.to - input.from > 30 * 24 * 60 * 60 * 1000
      ) {
        const error = new Error("Khoảng thời gian truy vấn không hợp lệ");
        error.code = "INVALID_TIME_RANGE";
        error.status = 400;
        throw error;
      }

      const result = await monitoring.repository.getLogs({
        page: input.page,
        pageSize: input.page_size,
        level: input.level,
        service: input.service,
        search: input.search,
        from: input.from,
        to: input.to,
      });

      res.json({
        success: true,
        data: result.items,
        meta: {
          page: result.page,
          page_size: result.pageSize,
          total: result.total,
          from: input.from,
          to: input.to,
        },
      });
    },
  );

  return router;
}
