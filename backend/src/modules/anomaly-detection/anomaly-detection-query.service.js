import { requireFound } from "../../common/errors.js";
import { requireRoomScope } from "../../common/authorization.js";

export class AnomalyDetectionQueryService {
  constructor(pool) {
    if (!pool) throw new TypeError("Cần PostgreSQL pool");
    this.pool = pool;
  }

  async list(user, { page, page_size, room_id, device_id, anomaly_detected }) {
    const where = `
      WHERE (
        $1::boolean OR EXISTS (
          SELECT 1 FROM user_rooms ur
          WHERE ur.user_id=$2 AND ur.room_id=r.room_id
        )
      )
      AND ($3::bigint IS NULL OR r.room_id=$3)
      AND ($4::bigint IS NULL OR r.device_id=$4)
      AND ($5::boolean IS NULL OR r.anomaly_detected=$5)
    `;

    const params = [
      user.role === "ADMIN",
      user.user_id,
      room_id ?? null,
      device_id ?? null,
      anomaly_detected ?? null,
    ];

    const total = Number(
      (
        await this.pool.query(
          `SELECT count(*)
           FROM anomaly_detection_results r
           ${where}`,
          params,
        )
      ).rows[0].count,
    );

    const data = (
      await this.pool.query(
        `SELECT
           r.result_id,
           r.data_id,
           r.device_id,
           d.device_code,
           r.room_id,
           rm.room_code,
           rm.room_name,
           r.anomaly_detected,
           r.findings,
           r.analyzed_at,
           s.recorded_at
         FROM anomaly_detection_results r
         JOIN devices d ON d.device_id=r.device_id
         JOIN rooms rm ON rm.room_id=r.room_id
         JOIN sensor_data s ON s.data_id=r.data_id
         ${where}
         ORDER BY r.analyzed_at DESC,r.result_id DESC
         LIMIT $6 OFFSET $7`,
        [...params, page_size, (page - 1) * page_size],
      )
    ).rows;

    return {
      data,
      meta: {
        page,
        page_size,
        total,
      },
    };
  }

  async get(user, resultId) {
    const result = requireFound(
      (
        await this.pool.query(
          `SELECT
             r.result_id,
             r.data_id,
             r.device_id,
             d.device_code,
             r.room_id,
             rm.room_code,
             rm.room_name,
             r.anomaly_detected,
             r.findings,
             r.analyzed_at,
             s.recorded_at,
             s.temperature,
             s.humidity,
             s.lux,
             s.occupancy
           FROM anomaly_detection_results r
           JOIN devices d ON d.device_id=r.device_id
           JOIN rooms rm ON rm.room_id=r.room_id
           JOIN sensor_data s ON s.data_id=r.data_id
           WHERE r.result_id=$1`,
          [resultId],
        )
      ).rows[0],
      "Không tìm thấy kết quả phát hiện",
    );

    // Không cho phép xem kết quả thuộc phòng ngoài phạm vi truy cập.
    await requireRoomScope(this.pool, user, result.room_id);

    return result;
  }
}
