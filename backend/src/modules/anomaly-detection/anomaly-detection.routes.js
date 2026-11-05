import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";
import { AnomalyDetectionQueryService } from "./anomaly-detection-query.service.js";

const listSchema = z
  .object({
    ...pagination,
    room_id: idSchema.optional(),
    device_id: idSchema.optional(),
    anomaly_detected: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export function createAnomalyDetectionRoutes(pool) {
  const router = Router();
  const service = new AnomalyDetectionQueryService(pool);

  router.get(
    "/anomalies",
    authorize(pool, "anomalies:read"),
    async (req, res) => {
      const input = parse(listSchema, req.query);
      res.json({
        success: true,
        ...(await service.list(req.user, input)),
      });
    },
  );

  router.get(
    "/anomalies/:id",
    authorize(pool, "anomalies:read"),
    async (req, res) => {
      const resultId = parse(idSchema, req.params.id);
      res.json({
        success: true,
        data: await service.get(req.user, resultId),
      });
    },
  );

  return router;
}
