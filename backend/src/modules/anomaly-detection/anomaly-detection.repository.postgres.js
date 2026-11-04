export class PostgresAnomalyRepository {
  constructor(client, { deviceId, dataId, msgId, windowSize = 30 }) {
    this.client = client;
    this.deviceId = deviceId;
    this.dataId = dataId;
    this.msgId = msgId;
    this.windowSize = windowSize;
  }

  async getBaseline(_deviceCode, metric) {
    const row = (await this.client.query(
      "SELECT samples FROM anomaly_baselines WHERE device_id=$1 AND metric=$2 FOR UPDATE",
      [this.deviceId, metric],
    )).rows[0];
    return row?.samples ?? [];
  }

  async appendBaseline(_deviceCode, metric, value, windowSize = this.windowSize) {
    const row = (await this.client.query(
      `INSERT INTO anomaly_baselines(device_id,metric,samples)
       VALUES($1,$2,ARRAY[$3]::double precision[])
       ON CONFLICT(device_id,metric) DO UPDATE
       SET samples = CASE
         WHEN cardinality(anomaly_baselines.samples) >= $4
         THEN anomaly_baselines.samples[cardinality(anomaly_baselines.samples)-$4+2:cardinality(anomaly_baselines.samples)] || EXCLUDED.samples
         ELSE anomaly_baselines.samples || EXCLUDED.samples
       END, updated_at=now()
       RETURNING samples`,
      [this.deviceId, metric, value, windowSize],
    )).rows[0];
    return row.samples;
  }

  async getProcessedEvent(_deviceCode, eventId) {
    if (!eventId) return null;
    const row = (await this.client.query(
      "SELECT result FROM anomaly_detection_results WHERE device_id=$1 AND msg_id=$2",
      [this.deviceId, eventId],
    )).rows[0];
    return row?.result ?? null;
  }

  async saveProcessedEvent(_deviceCode, eventId, result) {
    if (!eventId) return;
    await this.client.query(
      `INSERT INTO anomaly_detection_results(data_id,device_id,msg_id,anomaly_detected,result,analyzed_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(data_id) DO NOTHING`,
      [this.dataId, this.deviceId, eventId, result.anomalyDetected, result, result.analyzedAt],
    );
  }

  async clearBaseline(_deviceCode, metric) {
    await this.client.query(
      "DELETE FROM anomaly_baselines WHERE device_id=$1 AND metric=$2",
      [this.deviceId, metric],
    );
  }
}