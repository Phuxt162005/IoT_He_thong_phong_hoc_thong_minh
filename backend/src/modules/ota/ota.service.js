import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { AppError, requireFound } from "../../common/errors.js";
import { lockActor, requireRoomScope } from "../../common/authorization.js";
import { parse } from "../../common/validation.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent } from "../../database/events.js";
import { requireDeviceScope } from "../devices/devices.service.js";

const firmwareSchema = z
  .object({
    version: z.string().trim().min(1).max(40),
    device_type: z.enum(["SENSOR_NODE", "CONTROL_NODE"]),
    hardware_target: z.string().trim().min(1).max(80),
    file_name: z.string().trim().min(1).max(255),
    release_notes: z.string().max(2000).optional(),
  })
  .strict();

const otaStatusSchema = z
  .object({
    job_id: z.uuid(),
    device_id: z.string().min(1).max(40),
    room_id: z.string().min(1).max(40),
    session_id: z.string().min(1).max(64),
    status: z.enum([
      "DOWNLOADING",
      "VERIFYING",
      "INSTALLING",
      "REBOOTING",
      "SUCCESS",
      "FAILED",
      "ROLLED_BACK",
    ]),
    progress: z.number().int().min(0).max(100).optional(),
    error_code: z
      .string()
      .regex(/^[A-Z0-9_]{1,40}$/)
      .optional(),
    version: z.string().max(40).optional(),
    timestamp: z.number().int().min(0).max(8640000000000000),
  })
  .strict();

const activeStatuses = [
  "PENDING",
  "NOTIFIED",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
  "REBOOTING",
];

const firmwareView = (row) => ({
  firmware_id: row.firmware_id,
  version: row.version,
  device_type: row.device_type,
  hardware_target: row.hardware_target,
  file_name: row.file_name,
  file_size: row.file_size,
  sha256: row.sha256,
  release_notes: row.release_notes,
  status: row.status,
  created_at: row.created_at,
  published_at: row.published_at,
});

const jobView = (row) => ({
  job_id: row.job_id,
  firmware_id: row.firmware_id,
  device_id: row.device_id,
  room_id: row.room_id,
  previous_firmware_version: row.previous_firmware_version,
  status: row.status,
  progress: row.progress,
  error_code: row.error_code,
  created_at: row.created_at,
  started_at: row.started_at,
  last_status_at: row.last_status_at,
  finished_at: row.finished_at,
  timeout_at: row.timeout_at,
});

export class OtaService {
  constructor({
    pool,
    repository,
    mqtt,
    storage,
    downloadUrlSigner,
    heartbeatTimeoutSeconds = 30,
    timeoutSeconds = 900,
    downloadUrlLifetimeSeconds = 300,
  }) {
    if (!pool || !repository || !mqtt || !storage || !downloadUrlSigner) {
      throw new TypeError("OtaService thiếu dependency bắt buộc");
    }

    this.pool = pool;
    this.repository = repository;
    this.mqtt = mqtt;
    this.storage = storage;
    this.downloadUrlSigner = downloadUrlSigner;
    this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds;
    this.timeoutSeconds = timeoutSeconds;
    this.downloadUrlLifetimeSeconds = downloadUrlLifetimeSeconds;
    this.publishingJobs = new Set();
  }

  async assertDeviceReady(client, device) {
    if (!this.mqtt.ready) {
      throw new AppError(
        "BROKER_UNAVAILABLE",
        503,
        "MQTT broker chưa sẵn sàng",
      );
    }

    if (
      !["PROVISIONED", "ACTIVE"].includes(device.lifecycle_status) ||
      device.connection_status !== "ONLINE" ||
      !device.session_id ||
      !device.last_heartbeat_at ||
      Date.now() - device.last_heartbeat_at.getTime() >
        this.heartbeatTimeoutSeconds * 1000
    ) {
      throw new AppError(
        "DEVICE_NOT_READY",
        409,
        "Thiết bị chưa sẵn sàng cập nhật firmware",
      );
    }

    if (device.room_status !== "ACTIVE") {
      throw new AppError("ROOM_INACTIVE", 409, "Phòng học không hoạt động");
    }

    if (device.broker_sync_status !== "SYNCED") {
      throw new AppError(
        "CREDENTIAL_NOT_READY",
        409,
        "Thiết bị chưa đồng bộ với MQTT broker",
      );
    }

    const credential = await this.repository.getActiveCredential(
      client,
      device.device_id,
    );
    const session = await this.repository.getCurrentSession(
      client,
      device.device_id,
      device.session_id,
    );

    if (!credential || !session) {
      throw new AppError(
        "DEVICE_SESSION_INVALID",
        409,
        "Credential hoặc phiên kết nối thiết bị không hợp lệ",
      );
    }

    return { credential };
  }

  async registerFirmware(actor, input, file, requestId) {
    input = parse(firmwareSchema, input);

    if (
      !file?.buffer ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length === 0
    ) {
      throw new AppError(
        "FIRMWARE_FILE_REQUIRED",
        400,
        "Chưa cung cấp file firmware hợp lệ",
      );
    }

    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const fileSize = file.buffer.length;
    const firmwareId = randomUUID();

    // Storage phải lưu file và trả về storage_path ổn định.
    const stored = await this.storage.save({
      firmwareId,
      fileName: input.file_name,
      buffer: file.buffer,
    });

    if (!stored?.storage_path) {
      throw new AppError(
        "FIRMWARE_STORAGE_FAILED",
        500,
        "Không lưu được file firmware",
      );
    }

    try {
      const firmware = await withTransaction(this.pool, async (client) => {
        const current = await lockActor(client, actor, "ota:firmware:write");

        const row = await this.repository.createFirmware(client, {
          firmware_id: firmwareId,
          version: input.version,
          device_type: input.device_type,
          hardware_target: input.hardware_target,
          file_name: input.file_name,
          storage_path: stored.storage_path,
          file_size: fileSize,
          sha256,
          release_notes: input.release_notes ?? "",
          created_by: current.user_id,
        });

        await writeAudit(client, {
          actorType: "USER",
          actorId: current.user_id,
          action: "OTA_FIRMWARE_REGISTER",
          targetType: "FIRMWARE",
          targetId: firmwareId,
          requestId,
          details: {
            version: input.version,
            device_type: input.device_type,
            hardware_target: input.hardware_target,
            file_size: fileSize,
            sha256,
          },
        });

        return row;
      });

      return firmwareView(firmware);
    } catch (error) {
      // Xóa file đã lưu nếu transaction đăng ký metadata thất bại.
      await this.storage.remove(stored.storage_path).catch(() => {});
      throw error;
    }
  }

  async publishFirmware(actor, firmwareId, requestId) {
    return withTransaction(this.pool, async (client) => {
      const current = await lockActor(client, actor, "ota:firmware:write");
      const firmware = requireFound(
        await this.repository.getFirmware(client, firmwareId, {
          forUpdate: true,
        }),
        "Không tìm thấy firmware",
      );

      if (firmware.status !== "DRAFT") {
        throw new AppError(
          "FIRMWARE_NOT_DRAFT",
          409,
          "Chỉ firmware ở trạng thái DRAFT mới được phát hành",
        );
      }

      // Kiểm tra file thực tế trước khi cho phép phát hành.
      const artifact = await this.storage.read(firmware.storage_path);
      if (!artifact || artifact.length !== Number(firmware.file_size)) {
        throw new AppError(
          "FIRMWARE_FILE_INVALID",
          409,
          "File firmware không tồn tại hoặc sai kích thước",
        );
      }

      const actualHash = createHash("sha256").update(artifact).digest("hex");
      if (actualHash !== firmware.sha256) {
        throw new AppError(
          "FIRMWARE_HASH_MISMATCH",
          409,
          "SHA-256 của firmware không khớp",
        );
      }

      const published = requireFound(
        await this.repository.publishFirmware(client, firmwareId),
        "Không thể phát hành firmware",
      );

      await writeAudit(client, {
        actorType: "USER",
        actorId: current.user_id,
        action: "OTA_FIRMWARE_PUBLISH",
        targetType: "FIRMWARE",
        targetId: firmwareId,
        requestId,
        details: {
          version: firmware.version,
          device_type: firmware.device_type,
        },
      });

      await enqueueIotEvent(client, "ota.firmware_published", {
        firmware_id: firmwareId,
        version: firmware.version,
        device_type: firmware.device_type,
      });

      return firmwareView(published);
    });
  }

  async requestUpdate(actor, deviceId, firmwareId, requestId) {
    const queued = await withTransaction(this.pool, async (client) => {
      const current = await lockActor(client, actor, "ota:jobs:create");
      await requireDeviceScope(client, current, deviceId);

      const device = requireFound(
        await this.repository.getDevice(client, deviceId, { forUpdate: true }),
        "Không tìm thấy thiết bị",
      );

      const { credential } = await this.assertDeviceReady(client, device);

      const firmware = requireFound(
        await this.repository.getPublishedFirmware(client, firmwareId, {
          forUpdate: true,
        }),
        "Không tìm thấy firmware đã phát hành",
      );

      if (firmware.device_type !== device.device_type) {
        throw new AppError(
          "FIRMWARE_DEVICE_TYPE_MISMATCH",
          400,
          "Firmware không dành cho loại thiết bị này",
        );
      }

      if (firmware.hardware_target !== device.hardware_version) {
        throw new AppError(
          "FIRMWARE_HARDWARE_MISMATCH",
          400,
          "Firmware không tương thích với phần cứng thiết bị",
        );
      }

      const activeJob = await client.query(
        `SELECT job_id FROM ota_jobs
         WHERE device_id=$1 AND status=ANY($2::varchar[])
         LIMIT 1 FOR UPDATE`,
        [deviceId, activeStatuses],
      );

      if (activeJob.rowCount) {
        throw new AppError(
          "OTA_JOB_ALREADY_ACTIVE",
          409,
          "Thiết bị đang có một yêu cầu OTA chưa hoàn tất",
        );
      }

      const job = await this.repository.createJob(client, {
        job_id: randomUUID(),
        firmware_id: firmware.firmware_id,
        device_id: device.device_id,
        room_id: device.room_id,
        session_id: device.session_id,
        credential_version: credential.version,
        previous_firmware_version: device.firmware_version,
        requested_by: current.user_id,
        timeout_seconds: this.timeoutSeconds,
      });

      await writeAudit(client, {
        actorType: "USER",
        actorId: current.user_id,
        action: "OTA_JOB_CREATE",
        targetType: "OTA_JOB",
        targetId: job.job_id,
        requestId,
        details: {
          device_id: device.device_id,
          firmware_id: firmware.firmware_id,
          version: firmware.version,
        },
      });

      await enqueueIotEvent(client, "ota.job_created", {
        job_id: job.job_id,
        device_id: device.device_id,
        room_id: device.room_id,
        status: job.status,
      });

      return { job, firmware, device, credential };
    });

    const published = await this.publishOne(queued.job.job_id);
    return jobView(published);
  }

  async publishOne(jobId) {
    if (this.publishingJobs.has(jobId)) {
      return requireFound(
        (
          await this.pool.query("SELECT * FROM ota_jobs WHERE job_id=$1", [
            jobId,
          ])
        ).rows[0],
        "Không tìm thấy OTA Job",
      );
    }

    this.publishingJobs.add(jobId);

    try {
      let prepared;

      try {
        prepared = await withTransaction(this.pool, async (client) => {
          const initial = requireFound(
            (
              await client.query("SELECT * FROM ota_jobs WHERE job_id=$1", [
                jobId,
              ])
            ).rows[0],
            "Không tìm thấy OTA Job",
          );

          const device = requireFound(
            await this.repository.getDevice(client, initial.device_id, {
              forUpdate: true,
            }),
            "Không tìm thấy thiết bị",
          );

          const job = requireFound(
            await this.repository.getJob(client, jobId, { forUpdate: true }),
            "Không tìm thấy OTA Job",
          );

          if (job.status !== "PENDING") return { job };

          if (job.timeout_at <= new Date()) {
            return {
              job: await this.repository.updateJobStatus(client, jobId, {
                status: "TIMEOUT",
                error_code: "OTA_TIMEOUT",
              }),
            };
          }

          const firmware = requireFound(
            await this.repository.getPublishedFirmware(
              client,
              job.firmware_id,
              { forUpdate: true },
            ),
            "Firmware không còn được phát hành",
          );

          const { credential } = await this.assertDeviceReady(client, device);

          if (
            device.session_id !== job.session_id ||
            credential.version !== job.credential_version
          ) {
            throw new AppError(
              "DEVICE_SESSION_INVALID",
              409,
              "Phiên hoặc credential của thiết bị đã thay đổi",
            );
          }

          if (
            firmware.device_type !== device.device_type ||
            firmware.hardware_target !== device.hardware_version
          ) {
            throw new AppError(
              "FIRMWARE_INCOMPATIBLE",
              409,
              "Firmware không tương thích với thiết bị",
            );
          }

          return { job, firmware, device };
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code === "BROKER_UNAVAILABLE") {
          return requireFound(
            (
              await this.pool.query("SELECT * FROM ota_jobs WHERE job_id=$1", [
                jobId,
              ])
            ).rows[0],
            "Không tìm thấy OTA Job",
          );
        }
        return await withTransaction(this.pool, async (client) => {
          const job = await this.repository.getJob(client, jobId, {
            forUpdate: true,
          });
          if (!job || job.status !== "PENDING") return job;

          return this.repository.updateJobStatus(client, jobId, {
            status: "FAILED",
            error_code: error.code,
          });
        });
      }

      if (!prepared.firmware) return prepared.job;

      const { job, firmware, device } = prepared;
      const expiresAt = new Date(
        Date.now() + this.downloadUrlLifetimeSeconds * 1000,
      );
      const downloadUrl = await this.downloadUrlSigner.create(
        firmware.storage_path,
        expiresAt,
      );

      const topic = `smartclassroom/room/${device.room_code}/device/${device.device_code}/ota/command`;

      const payload = {
        job_id: job.job_id,
        device_id: device.device_code,
        room_id: device.room_code,
        session_id: job.session_id,
        firmware_id: firmware.firmware_id,
        version: firmware.version,
        device_type: firmware.device_type,
        hardware_target: firmware.hardware_target,
        download_url: downloadUrl,
        file_size: Number(firmware.file_size),
        sha256: firmware.sha256,
        expires_at: expiresAt.getTime(),
      };

      // Publish sau COMMIT. Nếu publish lỗi, Job vẫn PENDING để scheduler thử lại.
      try {
        await this.mqtt.publish(topic, payload);
      } catch {
        return requireFound(
          (
            await this.pool.query("SELECT * FROM ota_jobs WHERE job_id=$1", [
              jobId,
            ])
          ).rows[0],
          "Không tìm thấy OTA Job",
        );
      }

      return withTransaction(this.pool, async (client) => {
        const current = await this.repository.getJob(client, jobId, {
          forUpdate: true,
        });
        if (!current || current.status !== "PENDING") return current;

        const sent = await this.repository.updateJobStatus(client, jobId, {
          status: "NOTIFIED",
          progress: 0,
        });

        await enqueueIotEvent(client, "ota.job_updated", {
          job_id: jobId,
          device_id: device.device_id,
          room_id: device.room_id,
          status: "NOTIFIED",
        });

        return sent;
      });
    } finally {
      this.publishingJobs.delete(jobId);
    }
  }

  async handle(envelope) {
    if (envelope.kind !== "ota/status") return;

    const data = parse(otaStatusSchema, envelope.payload);

    if (
      data.device_id !== envelope.deviceCode ||
      data.room_id !== envelope.roomCode ||
      data.timestamp > Date.now() + 300000
    ) {
      throw new AppError(
        "OTA_STATUS_MISMATCH",
        400,
        "Thông tin OTA Status không khớp topic hoặc thời gian",
      );
    }

    return withTransaction(this.pool, async (client) => {
      const device = requireFound(
        (
          await client.query(
            `SELECT d.*,r.room_code
           FROM devices d JOIN rooms r ON r.room_id=d.room_id
           WHERE d.device_code=$1 AND r.room_code=$2
           FOR UPDATE OF d`,
            [envelope.deviceCode, envelope.roomCode],
          )
        ).rows[0],
        "Không tìm thấy thiết bị",
      );

      if (
        device.session_id !== data.session_id ||
        device.broker_sync_status !== "SYNCED"
      ) {
        throw new AppError(
          "OTA_SESSION_INVALID",
          409,
          "Phiên OTA không còn hợp lệ",
        );
      }

      const session = await this.repository.getCurrentSession(
        client,
        device.device_id,
        data.session_id,
      );
      const credential = await this.repository.getActiveCredential(
        client,
        device.device_id,
      );

      if (!session || !credential) {
        throw new AppError(
          "OTA_SESSION_INVALID",
          409,
          "Phiên hoặc credential đã bị thu hồi",
        );
      }

      const job = requireFound(
        await this.repository.getJob(client, data.job_id, { forUpdate: true }),
        "Không tìm thấy OTA Job",
      );

      const postRebootStatus = ["SUCCESS", "FAILED", "ROLLED_BACK"].includes(
        data.status,
      );

      const validSession =
        job.session_id === data.session_id ||
        (job.status === "REBOOTING" && postRebootStatus);

      if (
        job.device_id !== device.device_id ||
        !validSession ||
        job.credential_version !== credential.version
      ) {
        throw new AppError(
          "OTA_JOB_MISMATCH",
          400,
          "OTA Job không thuộc phiên thiết bị hợp lệ",
        );
      }

      if (!activeStatuses.includes(job.status)) {
        return { duplicate: true, job: jobView(job) };
      }

      if (job.timeout_at <= new Date()) {
        const expired = await this.repository.updateJobStatus(
          client,
          job.job_id,
          {
            status: "TIMEOUT",
            error_code: "OTA_TIMEOUT",
          },
        );
        return { duplicate: false, job: jobView(expired) };
      }

      if (data.status === "SUCCESS") {
        const firmware = requireFound(
          await this.repository.getFirmware(client, job.firmware_id),
          "Không tìm thấy firmware",
        );

        if (data.version !== firmware.version || data.progress !== 100) {
          throw new AppError(
            "OTA_SUCCESS_INVALID",
            400,
            "Thiết bị báo thành công nhưng phiên bản hoặc tiến độ không hợp lệ",
          );
        }
      }

      const updated = await this.repository.updateJobStatus(
        client,
        job.job_id,
        {
          status: data.status,
          progress: data.progress,
          error_code: data.error_code ?? null,
        },
      );

      if (data.status === "SUCCESS") {
        await client.query(
          "UPDATE devices SET firmware_version=$1 WHERE device_id=$2",
          [data.version, device.device_id],
        );
      }

      await writeAudit(client, {
        actorType: "DEVICE",
        actorId: device.device_id,
        action: "OTA_STATUS_UPDATE",
        targetType: "OTA_JOB",
        targetId: job.job_id,
        details: {
          status: data.status,
          progress: data.progress ?? null,
          error_code: data.error_code ?? null,
        },
      });

      await enqueueIotEvent(client, "ota.job_updated", {
        job_id: job.job_id,
        device_id: device.device_id,
        room_id: device.room_id,
        status: updated.status,
        progress: updated.progress,
      });

      return { duplicate: false, job: jobView(updated) };
    });
  }

  async listFirmware(actor, filters) {
    const result = await this.repository.listFirmware(this.pool, filters);
    return { ...result, data: result.data.map(firmwareView) };
  }

  async listJobs(actor, filters) {
    if (filters.room_id) {
      await requireRoomScope(this.pool, actor, filters.room_id);
    } else if (filters.device_id) {
      await requireDeviceScope(this.pool, actor, filters.device_id);
    } else if (actor.role !== "ADMIN") {
      throw new AppError(
        "SCOPE_REQUIRED",
        400,
        "Cần chỉ định phòng hoặc thiết bị để xem lịch sử OTA",
      );
    }

    const result = await this.repository.listJobs(this.pool, filters);
    return { ...result, data: result.data.map(jobView) };
  }

  async processPending() {
    const rows = await this.repository.listPendingJobs(this.pool, 10);
    let processed = 0;

    for (const row of rows) {
      await this.publishOne(row.job_id);
      processed++;
    }

    return processed;
  }

  async expirePending() {
    const rows = await this.repository.listExpiredJobs(this.pool, 100);
    let expired = 0;

    for (const row of rows) {
      await withTransaction(this.pool, async (client) => {
        const job = await this.repository.getJob(client, row.job_id, {
          forUpdate: true,
        });

        if (
          !job ||
          ![
            "PENDING",
            "NOTIFIED",
            "DOWNLOADING",
            "VERIFYING",
            "INSTALLING",
            "REBOOTING",
          ].includes(job.status)
        )
          return;
        if (job.timeout_at > new Date()) return;

        await this.repository.updateJobStatus(client, job.job_id, {
          status: "TIMEOUT",
          error_code: "OTA_TIMEOUT",
        });

        await enqueueIotEvent(client, "ota.job_updated", {
          job_id: job.job_id,
          device_id: job.device_id,
          room_id: job.room_id,
          status: "TIMEOUT",
        });

        expired++;
      });
    }
    return expired;
  }

  async revokeFirmware(actor, firmwareId, requestId) {
    return withTransaction(this.pool, async (client) => {
      const current = await lockActor(client, actor, "ota:firmware:write");

      const firmware = requireFound(
        await this.repository.getFirmware(client, firmwareId, {
          forUpdate: true,
        }),
        "Không tìm thấy firmware",
      );

      if (firmware.status !== "PUBLISHED") {
        throw new AppError(
          "FIRMWARE_NOT_PUBLISHED",
          409,
          "Chỉ firmware đã phát hành mới có thể thu hồi",
        );
      }

      const revoked = await this.repository.revokeFirmware(client, firmwareId);

      if (!revoked) {
        throw new AppError(
          "FIRMWARE_IN_USE",
          409,
          "Không thể thu hồi firmware đang có OTA Job hoạt động",
        );
      }

      await writeAudit(client, {
        actorType: "USER",
        actorId: current.user_id,
        action: "OTA_FIRMWARE_REVOKE",
        targetType: "FIRMWARE",
        targetId: firmwareId,
        requestId,
        details: { version: firmware.version },
      });

      await enqueueIotEvent(client, "ota.firmware_revoked", {
        firmware_id: firmwareId,
        version: firmware.version,
      });

      return firmwareView(revoked);
    });
  }
}

export function bindOta(mqtt, ota) {
  const handler = (envelope) => ota.handle(envelope);
  mqtt.on("device-message", handler);
  return () => mqtt.off("device-message", handler);
}
