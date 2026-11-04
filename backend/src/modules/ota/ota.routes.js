import { Router } from "express";
import express from "express";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { authorize } from "../../common/authorization.js";
import { idSchema, pagination, parse } from "../../common/validation.js";

const uuidSchema = z.uuid();

const firmwareHeaders = z
  .object({
    version: z.string().trim().min(1).max(40),
    device_type: z.enum(["SENSOR_NODE", "CONTROL_NODE"]),
    hardware_target: z.string().trim().min(1).max(80),
    file_name: z.string().trim().min(1).max(255),
    release_notes: z.string().max(2000).optional(),
  })
  .strict();

const firmwareFilters = z
  .object({
    ...pagination,
    device_type: z.enum(["SENSOR_NODE", "CONTROL_NODE"]).optional(),
    hardware_target: z.string().max(80).optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "REVOKED"]).optional(),
  })
  .strict();

const jobFilters = z
  .object({
    ...pagination,
    device_id: idSchema.optional(),
    room_id: idSchema.optional(),
    status: z
      .enum([
        "PENDING",
        "NOTIFIED",
        "DOWNLOADING",
        "VERIFYING",
        "INSTALLING",
        "REBOOTING",
        "SUCCESS",
        "FAILED",
        "ROLLED_BACK",
        "CANCELLED",
        "TIMEOUT",
      ])
      .optional(),
  })
  .strict();

export function createOtaRoutes(
  pool,
  ota,
  { maxFirmwareBytes = 4194304 } = {},
) {
  const router = Router();

  const available = (_req, _res, next) => {
    if (!ota)
      throw new AppError(
        "OTA_UNAVAILABLE",
        503,
        "Dịch vụ OTA chưa được cấu hình",
      );
    next();
  };

  router.post(
    "/ota/firmware",
    authorize(pool, "ota:firmware:write"),
    available,
    express.raw({ type: "application/octet-stream", limit: maxFirmwareBytes }),
    async (req, res) => {
      const metadata = parse(firmwareHeaders, {
        version: req.get("x-firmware-version"),
        device_type: req.get("x-device-type"),
        hardware_target: req.get("x-hardware-target"),
        file_name: req.get("x-firmware-file-name"),
        release_notes: req.get("x-release-notes") || undefined,
      });

      const result = await ota.registerFirmware(
        req.user,
        metadata,
        { buffer: req.body },
        req.requestId,
      );

      res.status(201).json({ success: true, data: result });
    },
  );

  router.get(
    "/ota/firmware",
    authorize(pool, "ota:firmware:read"),
    available,
    async (req, res) => {
      const filters = parse(firmwareFilters, req.query);
      res.json({
        success: true,
        ...(await ota.listFirmware(req.user, filters)),
      });
    },
  );

  router.post(
    "/ota/firmware/:id/publish",
    authorize(pool, "ota:firmware:write"),
    available,
    async (req, res) => {
      const result = await ota.publishFirmware(
        req.user,
        parse(uuidSchema, req.params.id),
        req.requestId,
      );
      res.json({ success: true, data: result });
    },
  );

  router.post(
    "/ota/firmware/:id/revoke",
    authorize(pool, "ota:firmware:write"),
    available,
    async (req, res) => {
      const result = await ota.revokeFirmware(
        req.user,
        parse(uuidSchema, req.params.id),
        req.requestId,
      );
      res.json({ success: true, data: result });
    },
  );

  router.post(
    "/devices/:id/ota",
    authorize(pool, "ota:jobs:create"),
    available,
    async (req, res) => {
      const body = parse(
        z.object({ firmware_id: uuidSchema }).strict(),
        req.body,
      );
      const result = await ota.requestUpdate(
        req.user,
        parse(idSchema, req.params.id),
        body.firmware_id,
        req.requestId,
      );
      res.status(202).json({ success: true, data: result });
    },
  );

  router.get(
    "/ota/jobs",
    authorize(pool, "ota:jobs:read"),
    available,
    async (req, res) => {
      const filters = parse(jobFilters, req.query);
      res.json({ success: true, ...(await ota.listJobs(req.user, filters)) });
    },
  );

  return router;
}
