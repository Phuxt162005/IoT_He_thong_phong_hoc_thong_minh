import { AppError } from "../../common/errors.js";

const firmwareColumns = `firmware_id,version,device_type,hardware_target,file_name,storage_path,file_size,sha256,signature,release_notes,status,created_by,created_at,published_at`;
const jobColumns = `job_id,firmware_id,device_id,room_id,session_id,credential_version,previous_firmware_version,status,progress,error_code,requested_by,created_at,started_at,last_status_at,finished_at,timeout_at`;

const terminalStatuses = [
  "SUCCESS",
  "FAILED",
  "ROLLED_BACK",
  "CANCELLED",
  "TIMEOUT",
];

const transitions = {
  PENDING: ["NOTIFIED", "FAILED", "CANCELLED", "TIMEOUT"],
  NOTIFIED: ["DOWNLOADING", "FAILED", "CANCELLED", "TIMEOUT"],
  DOWNLOADING: ["VERIFYING", "FAILED", "TIMEOUT"],
  VERIFYING: ["INSTALLING", "FAILED", "TIMEOUT"],
  INSTALLING: ["REBOOTING", "FAILED", "TIMEOUT"],
  REBOOTING: ["SUCCESS", "FAILED", "ROLLED_BACK", "TIMEOUT"],
};

export class OtaRepository {
  constructor(pool) {
    if (!pool) throw new TypeError("OtaRepository cần pool");
    this.pool = pool;
  }

  async createFirmware(client, input) {
    const result = await client.query(
      `INSERT INTO firmware_releases(firmware_id,version,device_type,hardware_target,file_name,storage_path,file_size,sha256,release_notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${firmwareColumns}`,
      [
        input.firmware_id,
        input.version,
        input.device_type,
        input.hardware_target,
        input.file_name,
        input.storage_path,
        input.file_size,
        input.sha256,
        input.release_notes ?? "",
        input.created_by,
      ],
    );
    return result.rows[0];
  }

  async getFirmware(client, firmwareId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT ${firmwareColumns} FROM firmware_releases WHERE firmware_id=$1 ${forUpdate ? "FOR UPDATE" : ""}`,
      [firmwareId],
    );
    return result.rows[0] ?? null;
  }

  async getPublishedFirmware(client, firmwareId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT ${firmwareColumns} FROM firmware_releases WHERE firmware_id=$1 AND status='PUBLISHED' ${forUpdate ? "FOR UPDATE" : ""}`,
      [firmwareId],
    );
    return result.rows[0] ?? null;
  }

  async publishFirmware(client, firmwareId, signature) {
    const result = await client.query(
      `UPDATE firmware_releases
      SET status='PUBLISHED',
         signature=$2,
         published_at=clock_timestamp()
      WHERE firmware_id=$1 AND status='DRAFT'
      RETURNING ${firmwareColumns}`,
      [firmwareId, signature],
    );

    return result.rows[0] ?? null;
  }

  async revokeFirmware(client, firmwareId) {
    const result = await client.query(
      `UPDATE firmware_releases f
       SET status='REVOKED'
       WHERE f.firmware_id=$1 AND f.status='PUBLISHED'
         AND NOT EXISTS (
           SELECT 1 FROM ota_jobs j
           WHERE j.firmware_id=f.firmware_id
             AND j.status=ANY($2::varchar[])
         )
       RETURNING ${firmwareColumns}`,
      [
        firmwareId,
        [
          "PENDING",
          "NOTIFIED",
          "DOWNLOADING",
          "VERIFYING",
          "INSTALLING",
          "REBOOTING",
        ],
      ],
    );
    return result.rows[0] ?? null;
  }

  async listFirmware(
    client,
    { device_type, hardware_target, status, page = 1, page_size = 20 } = {},
  ) {
    const params = [
      device_type ?? null,
      hardware_target ?? null,
      status ?? null,
    ];
    const where = `WHERE ($1::varchar IS NULL OR device_type=$1) AND ($2::varchar IS NULL OR hardware_target=$2) AND ($3::varchar IS NULL OR status=$3)`;
    const count = await client.query(
      `SELECT count(*) FROM firmware_releases ${where}`,
      params,
    );
    const result = await client.query(
      `SELECT ${firmwareColumns} FROM firmware_releases ${where}
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [...params, page_size, (page - 1) * page_size],
    );
    return {
      data: result.rows,
      meta: { page, page_size, total: Number(count.rows[0].count) },
    };
  }

  async createJob(client, input) {
    const result = await client.query(
      `INSERT INTO ota_jobs(job_id,firmware_id,device_id,room_id,session_id,credential_version,previous_firmware_version,requested_by,timeout_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9::double precision * interval '1 second'))
       RETURNING ${jobColumns}`,
      [
        input.job_id,
        input.firmware_id,
        input.device_id,
        input.room_id,
        input.session_id,
        input.credential_version,
        input.previous_firmware_version ?? null,
        input.requested_by,
        input.timeout_seconds,
      ],
    );

    const job = result.rows[0];

    await client.query(`INSERT INTO ota_command_outbox(job_id) VALUES($1)`, [
      job.job_id,
    ]);

    return job;
  }

  async getJob(client, jobId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT ${jobColumns} FROM ota_jobs WHERE job_id=$1 ${forUpdate ? "FOR UPDATE" : ""}`,
      [jobId],
    );
    return result.rows[0] ?? null;
  }

  async updateJobStatus(
    client,
    jobId,
    { status, progress, error_code = null },
  ) {
    const job = await this.getJob(client, jobId, { forUpdate: true });
    if (!job) return null;

    if (terminalStatuses.includes(job.status)) {
      if (job.status === status) return job;
      throw new AppError(
        "OTA_JOB_ALREADY_FINISHED",
        409,
        "OTA Job đã kết thúc và không thể thay đổi",
      );
    }

    const sameStatus = job.status === status;
    const allowed = transitions[job.status] ?? [];

    if (!sameStatus && !allowed.includes(status)) {
      throw new AppError(
        "OTA_INVALID_TRANSITION",
        409,
        `Không thể chuyển OTA Job từ ${job.status} sang ${status}`,
      );
    }

    if (progress !== undefined && progress !== null) {
      if (
        !Number.isInteger(progress) ||
        progress < job.progress ||
        progress > 100
      ) {
        throw new AppError(
          "OTA_INVALID_PROGRESS",
          400,
          "Tiến độ OTA không hợp lệ hoặc bị giảm",
        );
      }
    }

    if (status === "SUCCESS" && (progress ?? job.progress) !== 100) {
      throw new AppError(
        "OTA_INVALID_SUCCESS",
        409,
        "OTA chỉ được SUCCESS khi tiến độ đạt 100%",
      );
    }

    const terminal = terminalStatuses.includes(status);
    const result = await client.query(
      `UPDATE ota_jobs
       SET status=$1::varchar,
           progress=COALESCE($2,progress),
           error_code=$3,
           started_at=CASE WHEN $1::varchar='DOWNLOADING' AND started_at IS NULL THEN clock_timestamp() ELSE started_at END,
           last_status_at=clock_timestamp(),
           finished_at=CASE WHEN $4::boolean THEN COALESCE(finished_at,clock_timestamp()) ELSE NULL END
       WHERE job_id=$5
       RETURNING ${jobColumns}`,
      [status, progress ?? null, error_code, terminal, jobId],
    );
    return result.rows[0] ?? null;
  }

  async listJobs(
    client,
    { device_id, room_id, status, page = 1, page_size = 20 } = {},
  ) {
    const params = [device_id ?? null, room_id ?? null, status ?? null];
    const where = `WHERE ($1::bigint IS NULL OR device_id=$1) AND ($2::bigint IS NULL OR room_id=$2) AND ($3::varchar IS NULL OR status=$3)`;
    const count = await client.query(
      `SELECT count(*) FROM ota_jobs ${where}`,
      params,
    );
    const result = await client.query(
      `SELECT ${jobColumns} FROM ota_jobs ${where}
       ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [...params, page_size, (page - 1) * page_size],
    );
    return {
      data: result.rows,
      meta: { page, page_size, total: Number(count.rows[0].count) },
    };
  }

  async listPendingJobs(client, limit = 10) {
    const result = await client.query(
      `SELECT job_id FROM ota_jobs
       WHERE status='PENDING' AND timeout_at>clock_timestamp()
       ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async listExpiredJobs(client, limit = 100) {
    const result = await client.query(
      `SELECT job_id FROM ota_jobs
       WHERE status=ANY($1::varchar[]) AND timeout_at<=clock_timestamp()
       ORDER BY timeout_at LIMIT $2`,
      [
        [
          "PENDING",
          "NOTIFIED",
          "DOWNLOADING",
          "VERIFYING",
          "INSTALLING",
          "REBOOTING",
        ],
        limit,
      ],
    );
    return result.rows;
  }

  async getDevice(client, deviceId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT d.*,r.room_code,r.status AS room_status
       FROM devices d LEFT JOIN rooms r ON r.room_id=d.room_id
       WHERE d.device_id=$1 ${forUpdate ? "FOR UPDATE OF d" : ""}`,
      [deviceId],
    );
    return result.rows[0] ?? null;
  }

  async getActiveCredential(client, deviceId) {
    const result = await client.query(
      `SELECT credential_id,version,status,synced_at
       FROM device_credentials
       WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL`,
      [deviceId],
    );
    return result.rows[0] ?? null;
  }

  async getCurrentSession(client, deviceId, sessionId) {
    const result = await client.query(
      `SELECT session_id FROM device_sessions
       WHERE device_id=$1 AND session_id=$2 AND closed_at IS NULL`,
      [deviceId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  async claimOtaCommands(client, limit = 10) {
    const result = await client.query(
      `WITH candidates AS (
       SELECT outbox_id
       FROM ota_command_outbox
       WHERE (
         status = 'PENDING'
         OR (status = 'PROCESSING' AND locked_until <= clock_timestamp())
       )
       AND available_at <= clock_timestamp()
       ORDER BY available_at, outbox_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE ota_command_outbox o
     SET status = 'PROCESSING',
         attempts = attempts + 1,
         locked_until = clock_timestamp() + interval '30 seconds',
         updated_at = clock_timestamp()
     FROM candidates c
     WHERE o.outbox_id = c.outbox_id
     RETURNING o.outbox_id, o.job_id, o.attempts`,
      [limit],
    );
    return result.rows;
  }

  async getOtaCommandData(client, jobId) {
    const result = await client.query(
      `SELECT j.*, d.device_code, d.device_type, d.hardware_version,
            d.lifecycle_status, d.connection_status, d.session_id AS current_session_id,
            d.broker_sync_status, d.last_heartbeat_at,
            r.room_code, r.status AS room_status,
            f.version, f.hardware_target, f.storage_path,
            f.file_size, f.sha256, f.status AS firmware_status
     FROM ota_jobs j
     JOIN devices d ON d.device_id = j.device_id
     JOIN rooms r ON r.room_id = j.room_id
     JOIN firmware_releases f ON f.firmware_id = j.firmware_id
     WHERE j.job_id = $1`,
      [jobId],
    );
    return result.rows[0] ?? null;
  }

  async markOtaCommandSent(client, outboxId) {
    const result = await client.query(
      `UPDATE ota_command_outbox SET status = 'SENT',
         sent_at = clock_timestamp(),
         locked_until = NULL,
         last_error = NULL,
         updated_at = clock_timestamp()
     WHERE outbox_id = $1 AND status = 'PROCESSING'
     RETURNING *`,
      [outboxId],
    );
    return result.rows[0] ?? null;
  }

  async retryOtaCommand(client, outboxId, errorCode) {
    const result = await client.query(
      `UPDATE ota_command_outbox SET status = 'PENDING',
         locked_until = NULL,
         available_at = clock_timestamp() +
           LEAST(30, GREATEST(1, attempts * 2)) * interval '1 second',
         last_error = $2,
         updated_at = clock_timestamp()
     WHERE outbox_id = $1 AND status = 'PROCESSING'
     RETURNING *`,
      [outboxId, errorCode],
    );
    return result.rows[0] ?? null;
  }
}
