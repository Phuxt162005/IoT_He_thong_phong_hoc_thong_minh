import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { pagination, parse } from "../../common/validation.js";
import { AppError } from "../../common/errors.js";

const time = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

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

function requireMonitoring(monitoring, capability) {
  if (!monitoring || typeof monitoring[capability] !== "function") {
    throw new AppError(
      "MONITORING_UNAVAILABLE",
      503,
      "Monitoring service chưa được khởi tạo",
    );
  }
}

export function createMonitoringRoutes(pool, monitoring) {
  const router = Router();

  router.get(
    "/monitoring/snapshot",
    authorize(pool, "monitoring:read"),
    async (_req, res) => {
      requireMonitoring(monitoring, "getSnapshot");

      const data = await monitoring.getSnapshot();

      res.json({ success: true, data });
    },
  );

  router.get(
    "/monitoring/logs",
    authorize(pool, "monitoring:read"),
    async (req, res) => {
      requireMonitoring(monitoring, "getSnapshot");

      if (typeof monitoring.repository?.getLogs !== "function") {
        throw new AppError(
          "MONITORING_UNAVAILABLE",
          503,
          "Monitoring log repository chưa được khởi tạo",
        );
      }

      const input = parse(logQuery, req.query);

      input.to ??= new Date();
      input.from ??= new Date(input.to.getTime() - 24 * 60 * 60 * 1000);

      if (
        input.from >= input.to ||
        input.to - input.from > 30 * 24 * 60 * 60 * 1000
      ) {
        throw new AppError(
          "INVALID_TIME_RANGE",
          400,
          "Khoảng thời gian truy vấn không hợp lệ",
        );
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
