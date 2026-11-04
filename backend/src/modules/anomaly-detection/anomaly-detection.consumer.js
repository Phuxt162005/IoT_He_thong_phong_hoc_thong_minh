import { withTransaction } from "../../database/pool.js";
import { AnomalyDetectionService } from "./anomaly-detection.service.js";
import { PostgresAnomalyRepository } from "./anomaly-detection.repository.pg.js";

const CONSUMER = "anomaly_detection";

export class AnomalyDetectionConsumer {
  constructor({ pool, logger, batchSize = 100 }) {
    this.pool = pool;
    this.logger = logger;
    this.batchSize = batchSize;
  }

  async consumePending() {
    const pending = (
      await this.pool.query(
        `SELECT e.event_id,e.data_id,e.payload
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

          if (!sample || !event.payload.eligible) {
            await client.query(
              `INSERT INTO iot_event_deliveries(event_id,consumer)
               VALUES($1,$2) ON CONFLICT DO NOTHING`,
              [item.event_id, CONSUMER],
            );
            return "SKIPPED";
          }

          const device = (
            await client.query(
              `SELECT * FROM devices WHERE device_id=$1 FOR UPDATE`,
              [sample.device_id],
            )
          ).rows[0];

          if (!device || device.lifecycle_status !== "ACTIVE") {
            await client.query(
              `INSERT INTO iot_event_deliveries(event_id,consumer)
               VALUES($1,$2) ON CONFLICT DO NOTHING`,
              [item.event_id, CONSUMER],
            );
            return "SKIPPED";
          }

          const repository = new PostgresAnomalyRepository({
            client,
            dataId: sample.data_id,
            deviceId: sample.device_id,
            roomId: sample.room_id,
          });

          const service = new AnomalyDetectionService({
            repository,
          });

          await service.analyzeTelemetry({
            eventId: String(sample.data_id),
            deviceId: String(sample.device_id),
            timestamp: sample.recorded_at.toISOString(),
            temperatureC: sample.temperature,
            humidityPercent: sample.humidity,
            illuminanceLux: sample.lux,
          });

          await client.query(
            `INSERT INTO iot_event_deliveries(event_id,consumer)
             VALUES($1,$2) ON CONFLICT DO NOTHING`,
            [item.event_id, CONSUMER],
          );

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
