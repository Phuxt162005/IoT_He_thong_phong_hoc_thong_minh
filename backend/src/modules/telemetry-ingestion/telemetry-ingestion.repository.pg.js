import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors.js";

// One instance belongs to one message and the caller's transaction/locked device.
export class PostgresTelemetryRepository {
  constructor(client, context) { this.client = client; this.context = context; this.createdEvent = null; }
  async findByEventId(eventId) {
    const row = (await this.client.query("SELECT * FROM sensor_data WHERE device_id=$1 AND msg_id=$2", [this.context.device.device_id, eventId])).rows[0];
    if (row && row.payload_hash !== this.context.normalized.payloadHash) throw new AppError("EVENT_ID_CONFLICT", 409, "Mã bản tin đã được dùng với nội dung khác");
    return row ?? null;
  }
  async saveIfAbsent(event) {
    const { device, normalized, receivedAt, recordedAt, clockSkew, freshnessSeconds } = this.context;
    const previous = (await this.client.query("SELECT recorded_at FROM telemetry_latest WHERE device_id=$1", [device.device_id])).rows[0];
    const isBackfill = receivedAt - recordedAt > freshnessSeconds * 1000 || (previous && recordedAt < previous.recorded_at) || false;
    const inserted = (await this.client.query(`INSERT INTO sensor_data(device_id,room_id,msg_id,recorded_at,received_at,temperature,humidity,lux,occupancy,clock_skew,is_backfill,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(device_id,msg_id) DO NOTHING RETURNING *`,
      [device.device_id, device.room_id, event.eventId, recordedAt, receivedAt, event.temperatureC, event.humidityPercent, event.illuminanceLux, event.occupancy, clockSkew, isBackfill, normalized.payloadHash])).rows[0];
    if (!inserted) return { inserted: false, event: await this.findByEventId(event.eventId) };
    const latest = clockSkew ? { rowCount: 0 } : await this.client.query(`INSERT INTO telemetry_latest(device_id,data_id,recorded_at) VALUES($1,$2,$3)
      ON CONFLICT(device_id) DO UPDATE SET data_id=EXCLUDED.data_id,recorded_at=EXCLUDED.recorded_at
      WHERE (EXCLUDED.recorded_at,EXCLUDED.data_id) > (telemetry_latest.recorded_at,telemetry_latest.data_id) RETURNING data_id`, [device.device_id, inserted.data_id, recordedAt]);
    const eligible = device.lifecycle_status === "ACTIVE" && latest.rowCount > 0 && !clockSkew && !isBackfill;
    const payload = { data_id: inserted.data_id, device_id: device.device_id, room_id: device.room_id, eligible, is_latest: latest.rowCount > 0, is_backfill: isBackfill, clock_skew: clockSkew };
    const eventId = randomUUID();
    await this.client.query("INSERT INTO iot_events(event_id,data_id,event_type,payload) VALUES($1,$2,'telemetry.stored',$3)", [eventId, inserted.data_id, payload]);
    this.createdEvent = { event_id: eventId, ...payload, telemetry: inserted };
    return { inserted: true, event: inserted };
  }
}
