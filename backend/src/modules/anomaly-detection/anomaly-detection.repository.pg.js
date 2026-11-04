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

  async getProcessedEvent(deviceId, eventId) {
    if (!eventId) return null;

    const result = await this.client.query(
      `SELECT data_id,device_id,room_id,anomaly_detected,findings,analyzed_at
       FROM anomaly_detection_results
       WHERE data_id=$1 AND device_id=$2`,
      [eventId, deviceId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      eventId: String(row.data_id),
      deviceId: String(row.device_id),
      timestamp: null,
      analyzedAt: row.analyzed_at.toISOString(),
      anomalyDetected: row.anomaly_detected,
      findings: row.findings,
      duplicate: false,
    };
  }

  async saveProcessedEvent(deviceId, eventId, result) {
    if (!eventId) return;

    await this.client.query(
      `INSERT INTO anomaly_detection_results
       (data_id,device_id,room_id,anomaly_detected,findings,analyzed_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(data_id) DO NOTHING`,
      [
        eventId,
        deviceId,
        this.roomId,
        result.anomalyDetected,
        JSON.stringify(result.findings),
        result.analyzedAt,
      ],
    );
  }

  async clearBaseline(deviceId, metric) {
    await this.client.query(
      `DELETE FROM anomaly_baselines
       WHERE device_id=$1 AND metric=$2`,
      [deviceId, metric],
    );
  }
}
