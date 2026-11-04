import { withTransaction } from "../../database/pool.js";
import { AnomalyDetectionService } from "./anomaly-detection.service.js";
import { PostgresAnomalyRepository } from "./anomaly-detection.repository.postgres.js";

export class AnomalyDetectionConsumer {
  constructor({ pool, logger, minSamples = 8, windowSize = 30, threshold = 3.5 }) {
    this.pool = pool;
    this.logger = logger;
    this.options = { minSamples, windowSize, threshold };
  }

  async consumePending(limit = 100) {
    const pending = (await this.pool.query(
      `SELECT e.event_id, e.data_id
       FROM iot_events e
       WHERE e.event_type='telemetry.stored'
         AND NOT EXISTS (
           SELECT 1 FROM iot_event_deliveries d
           WHERE d.event_id=e.event_id AND d.consumer='anomaly'
         )
       ORDER BY e.created_at, e.event_id
       LIMIT $1`,
      [limit],
    )).rows;

    let processed = 0;
    for (const item of pending) {
      try {
        await withTransaction(this.pool, async (client) => {
          const event = (await client.query(
            "SELECT * FROM iot_events WHERE event_id=$1 FOR UPDATE",
            [item.event_id],
          )).rows[0];
          if (!event) return;
          const delivered = await client.query(
            "SELECT 1 FROM iot_event_deliveries WHERE event_id=$1 AND consumer='anomaly'",
            [item.event_id],
          );
          if (delivered.rowCount) return;

          const sample = (await client.query(
            `SELECT s.*, d.device_code
             FROM sensor_data s JOIN devices d ON d.device_id=s.device_id
             WHERE s.data_id=$1`,
            [event.data_id],
          )).rows[0];
          if (!sample) {
            await client.query(
              "INSERT INTO iot_event_deliveries(event_id,consumer) VALUES($1,'anomaly') ON CONFLICT DO NOTHING",
              [item.event_id],
            );
            return;
          }

          const repository = new PostgresAnomalyRepository(client, {
            deviceId: sample.device_id,
            dataId: sample.data_id,
            msgId: sample.msg_id,
            windowSize: this.options.windowSize,
          });
          const service = new AnomalyDetectionService({
            repository,
            ...this.options,
            now: () => new Date().toISOString(),
          });
          await service.analyzeTelemetry({
            eventId: sample.msg_id,
            deviceId: sample.device_code,
            timestamp: sample.recorded_at.toISOString(),
            temperatureC: sample.temperature,
            humidityPercent: sample.humidity,
            illuminanceLux: sample.lux,
          });

          await client.query(
            "INSERT INTO iot_event_deliveries(event_id,consumer) VALUES($1,'anomaly') ON CONFLICT DO NOTHING",
            [item.event_id],
          );
          processed++;
        });
      } catch (error) {
        this.logger.warn("anomaly.consume_failed", {
          eventId: item.event_id,
          code: error.code ?? "ANOMALY_PROCESSING_ERROR",
        });
      }
    }
    return processed;
  }
}