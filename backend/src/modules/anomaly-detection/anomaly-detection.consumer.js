import { withTransaction } from "../../database/pool.js";
import { AnomalyDetectionService } from "./anomaly-detection.service.js";
import { PostgresAnomalyRepository } from "./anomaly-detection.repository.pg.js";

const CONSUMER = "anomaly_detection";

export class AnomalyDetectionConsumer {
  constructor({ pool, logger, batchSize = 100 }) {
    if (!pool) throw new TypeError("Cần PostgreSQL pool");
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new TypeError("batchSize phải nằm trong khoảng 1–1000");
    }
    this.pool = pool;
    this.logger = logger;
    this.batchSize = batchSize;
  }

  async consumePending() {
    const pending = (
      await this.pool.query(
        `SELECT e.event_id
         FROM iot_events e
         WHERE e.event_type='telemetry.stored'
           AND NOT EXISTS (
             SELECT 1 FROM iot_event_deliveries d
             WHERE d.event_id=e.event_id AND d.consumer=$1
           )
         ORDER BY e.created_at,e.event_id
         LIMIT $2`,
        [CONSUMER, this.batchSize],
      )
    ).rows;

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        const outcome = await withTransaction(this.pool, async (client) => {
          const event = (
            await client.query(
              `SELECT * FROM iot_events
               WHERE event_id=$1 FOR UPDATE`,
              [item.event_id],
            )
          ).rows[0];

          if (!event) return "SKIPPED";

          const delivered = await client.query(
            `SELECT 1 FROM iot_event_deliveries
             WHERE event_id=$1 AND consumer=$2`,
            [item.event_id, CONSUMER],
          );

          if (delivered.rowCount) return "SKIPPED";

          const sample = (
            await client.query(`SELECT * FROM sensor_data WHERE data_id=$1`, [
              event.data_id,
            ])
          ).rows[0];

          const markDelivered = async () => {
            await client.query(
              `INSERT INTO iot_event_deliveries(event_id,consumer)
               VALUES($1,$2) ON CONFLICT DO NOTHING`,
              [item.event_id, CONSUMER],
            );
          };

          if (!sample) {
            await markDelivered();
            return "SKIPPED";
          }

          // Chỉ phân tích dữ liệu mới nhất, hợp lệ, không lệch đồng hồ,
          // không phải dữ liệu bù và được pipeline đánh dấu eligible.
          const eligible =
            event.payload?.eligible === true &&
            event.payload?.is_latest === true &&
            event.payload?.is_backfill === false &&
            event.payload?.clock_skew === false &&
            sample.is_backfill === false &&
            sample.clock_skew === false;

          if (!eligible) {
            await markDelivered();
            return "SKIPPED";
          }

          const device = (
            await client.query(
              `SELECT * FROM devices WHERE device_id=$1 FOR UPDATE`,
              [sample.device_id],
            )
          ).rows[0];

          const room = (
            await client.query(`SELECT status FROM rooms WHERE room_id=$1`, [
              sample.room_id,
            ])
          ).rows[0];

          if (
            !device ||
            device.lifecycle_status !== "ACTIVE" ||
            !room ||
            room.status !== "ACTIVE"
          ) {
            await markDelivered();
            return "SKIPPED";
          }

          const repository = new PostgresAnomalyRepository({
            client,
            dataId: sample.data_id,
            deviceId: sample.device_id,
            roomId: sample.room_id,
          });

          const service = new AnomalyDetectionService({ repository });

          await service.analyzeTelemetry({
            eventId: String(sample.data_id),
            deviceId: String(sample.device_id),
            timestamp: sample.recorded_at.toISOString(),
            temperatureC: sample.temperature,
            humidityPercent: sample.humidity,
            illuminanceLux: sample.lux,
          });

          const latest = (
            await client.query(
              `SELECT data_id FROM telemetry_latest WHERE device_id=$1`,
              [sample?.device_id],
            )
          ).rows[0];

          if (
            !sample ||
            !latest ||
            String(latest.data_id) !== String(sample.data_id)
          ) {
            await markDelivered();
            return "SKIPPED";
          }

          // Chỉ đánh dấu đã xử lý sau khi kết quả và baseline được lưu thành công.
          await markDelivered();
          return "PROCESSED";
        });

        if (outcome === "PROCESSED") processed++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logger?.warn("anomaly_detection.processing_failed", {
          eventId: item.event_id,
          code: error.code ?? "ANOMALY_DETECTION_ERROR",
        });
      }
    }

    return { processed, skipped, failed };
  }
}
