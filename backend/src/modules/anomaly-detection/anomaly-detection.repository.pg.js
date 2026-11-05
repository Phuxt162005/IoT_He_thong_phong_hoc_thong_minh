import { enqueueIotEvent } from "../../database/events.js";

export class PostgresAnomalyRepository {
  constructor({ client, dataId, deviceId, roomId }) {
    this.client = client;
    this.dataId = dataId;
    this.deviceId = deviceId;
    this.roomId = roomId;
  }

  async getBaseline(deviceId, metric) {
    const result = await this.client.query(
      `SELECT samples FROM anomaly_baselines
       WHERE device_id=$1 AND metric=$2 FOR UPDATE`,
      [deviceId, metric],
    );
    return result.rows[0]?.samples ?? [];
  }

  async appendBaseline(deviceId, metric, value, windowSize) {
    const history = await this.getBaseline(deviceId, metric);
    const samples = [...history, value].slice(-windowSize);

    await this.client.query(
      `INSERT INTO anomaly_baselines(device_id,metric,samples,sample_count,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(device_id,metric) DO UPDATE
       SET samples=EXCLUDED.samples,
           sample_count=EXCLUDED.sample_count,
           updated_at=now()`,
      [deviceId, metric, samples, samples.length],
    );

    return samples;
  }

  // Lấy kết quả đã xử lý để bảo đảm một telemetry không bị phân tích hai lần.
  async getProcessedEvent(deviceId, eventId) {
    if (!eventId) return null;

    const result = await this.client.query(
      `SELECT
         r.data_id,
         r.device_id,
         r.room_id,
         r.anomaly_detected,
         r.findings,
         r.analyzed_at,
         s.recorded_at
       FROM anomaly_detection_results r
       JOIN sensor_data s ON s.data_id=r.data_id
       WHERE r.data_id=$1`,
      [eventId],
    );

    const row = result.rows[0];
    if (!row) return null;

    if (String(row.device_id) !== String(deviceId)) {
      throw new Error("ANOMALY_EVENT_DEVICE_MISMATCH");
    }

    return {
      eventId: String(row.data_id),
      deviceId: String(row.device_id),
      timestamp: row.recorded_at.toISOString(),
      analyzedAt: row.analyzed_at.toISOString(),
      anomalyDetected: row.anomaly_detected,
      findings: row.findings,
      duplicate: false,
    };
  }

  // Lưu kết quả và phát sự kiện trong cùng transaction.
  async saveProcessedEvent(deviceId, eventId, result) {
    if (!eventId) return;

    const inserted = await this.client.query(
      `INSERT INTO anomaly_detection_results
       (data_id,device_id,room_id,anomaly_detected,findings,analyzed_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(data_id) DO NOTHING
       RETURNING result_id`,
      [
        eventId,
        deviceId,
        this.roomId,
        result.anomalyDetected,
        JSON.stringify(result.findings),
        result.analyzedAt,
      ],
    );

    // Chỉ phát sự kiện khi kết quả mới được lưu và có bất thường.
    if (inserted.rowCount > 0 && result.anomalyDetected) {
      await enqueueIotEvent(this.client, "anomaly.detected", {
        anomaly_result_id: String(inserted.rows[0].result_id),
        data_id: String(eventId),
        device_id: String(deviceId),
        room_id: String(this.roomId),
        anomaly_detected: true,
        findings: result.findings.filter((item) => item.anomaly),
      });
    }
  }

  async clearBaseline(deviceId, metric) {
    await this.client.query(
      `DELETE FROM anomaly_baselines
       WHERE device_id=$1 AND metric=$2`,
      [deviceId, metric],
    );
  }
}
