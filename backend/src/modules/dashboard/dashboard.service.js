import { AppError } from "../../common/errors.js";
import { requireRoomScope } from "../../common/authorization.js";
import { requireDeviceScope } from "../devices/devices.service.js";

const columns = "s.data_id,s.device_id,s.room_id,s.msg_id,s.recorded_at,s.received_at,s.temperature,s.humidity,s.lux,s.occupancy,s.clock_skew,s.is_backfill";
export function publicTelemetry(row) {
  const { data_id, device_id, room_id, msg_id, recorded_at, received_at, temperature, humidity, lux, occupancy, clock_skew, is_backfill } = row;
  return { data_id, device_id, room_id, msg_id, recorded_at, received_at, temperature, humidity, lux, occupancy, clock_skew, is_backfill };
}
export function csvCell(value) {
  let cell = value instanceof Date ? value.toISOString() : value === null || value === undefined ? "" : String(value);
  if (/^[=+@\-\t\r]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}
export class DashboardService {
  constructor({ pool, freshnessSeconds = 30 }) { this.pool = pool; this.freshnessSeconds = freshnessSeconds; }
  async scope(user, { roomId, deviceId }) {
    if (roomId) await requireRoomScope(this.pool, user, roomId);
    if (deviceId) {
      const device = await requireDeviceScope(this.pool, user, deviceId);
      if (roomId && device.room_id !== roomId) throw new AppError("NOT_FOUND", 404, "Không tìm thấy thiết bị trong phòng");
    }
  }
  async history(user, scope, query, { csv = false } = {}) {
    await this.scope(user, scope);
    const { from, to, page, page_size } = query;
    const params = [scope.roomId ?? null, scope.deviceId ?? null, from, to];
    const where = "WHERE ($1::bigint IS NULL OR s.room_id=$1) AND ($2::bigint IS NULL OR s.device_id=$2) AND s.recorded_at >= $3 AND s.recorded_at < $4";
    if (csv) {
      const rows = (await this.pool.query(`SELECT ${columns} FROM sensor_data s ${where} ORDER BY s.recorded_at,s.data_id LIMIT 5001`, params)).rows;
      if (rows.length > 5000) throw new AppError("EXPORT_TOO_LARGE", 413, "CSV tối đa 5000 mẫu; hãy thu hẹp thời gian");
      const keys = ["data_id", "device_id", "room_id", "msg_id", "recorded_at", "received_at", "temperature", "humidity", "lux", "occupancy", "clock_skew", "is_backfill"];
      return [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
    }
    const total = Number((await this.pool.query(`SELECT count(*) FROM sensor_data s ${where}`, params)).rows[0].count);
    const data = (await this.pool.query(`SELECT ${columns} FROM sensor_data s ${where} ORDER BY s.recorded_at DESC,s.data_id DESC LIMIT $5 OFFSET $6`, [...params, page_size, (page - 1) * page_size])).rows;
    return { data, meta: { page, page_size, total, from, to } };
  }
  async latest(user, roomId, { page, page_size }) {
    await requireRoomScope(this.pool, user, roomId);
    const total = Number((await this.pool.query("SELECT count(*) FROM telemetry_latest l JOIN devices d USING(device_id) WHERE d.room_id=$1", [roomId])).rows[0].count);
    const data = (await this.pool.query(`SELECT ${columns},d.device_code,d.lifecycle_status,d.connection_status FROM telemetry_latest l
      JOIN sensor_data s ON s.data_id=l.data_id JOIN devices d ON d.device_id=l.device_id
      WHERE s.room_id=$1 ORDER BY s.recorded_at DESC,s.data_id DESC LIMIT $2 OFFSET $3`, [roomId, page_size, (page - 1) * page_size])).rows.map((row) => ({ ...row, stale: Date.now() - row.recorded_at.getTime() > this.freshnessSeconds * 1000 }));
    return { data, meta: { page, page_size, total } };
  }
  async stats(user, roomId, { from, to, bucket }) {
    await requireRoomScope(this.pool, user, roomId);
    return (await this.pool.query(`SELECT date_trunc($4::text,recorded_at,'UTC') AS bucket_at,count(*)::integer AS sample_count,
      avg(temperature) AS temperature_avg,min(temperature) AS temperature_min,max(temperature) AS temperature_max,
      avg(humidity) AS humidity_avg,min(humidity) AS humidity_min,max(humidity) AS humidity_max,
      avg(lux) AS lux_avg,min(lux) AS lux_min,max(lux) AS lux_max,
      count(*) FILTER(WHERE occupancy IS TRUE)::integer AS occupied_samples,count(occupancy)::integer AS occupancy_known_samples
      FROM sensor_data WHERE room_id=$1 AND recorded_at >= $2 AND recorded_at < $3 AND NOT clock_skew
      GROUP BY bucket_at ORDER BY bucket_at`, [roomId, from, to, bucket])).rows;
  }
  async dashboard(user, roomId) {
    if (roomId) await requireRoomScope(this.pool, user, roomId);
    const params = [user.role === "ADMIN", user.user_id, roomId ?? null];
    const scope = "($1::boolean OR EXISTS(SELECT 1 FROM user_rooms ur WHERE ur.user_id=$2 AND ur.room_id=r.room_id)) AND ($3::bigint IS NULL OR r.room_id=$3)";
    const rooms = Number((await this.pool.query(`SELECT count(*) FROM rooms r WHERE ${scope}`, params)).rows[0].count);
    const deviceCounts = (await this.pool.query(`SELECT d.lifecycle_status,d.connection_status,count(*)::integer AS count FROM devices d JOIN rooms r USING(room_id) WHERE ${scope} GROUP BY d.lifecycle_status,d.connection_status ORDER BY d.lifecycle_status,d.connection_status`, params)).rows;
    const alerts = (await this.pool.query(`SELECT a.severity,count(*)::integer AS count FROM alerts a JOIN rooms r USING(room_id) WHERE a.status<>'RESOLVED' AND ${scope} GROUP BY a.severity ORDER BY a.severity`, params)).rows;
    const latest = (await this.pool.query(`SELECT ${columns},d.device_code FROM telemetry_latest l JOIN sensor_data s ON s.data_id=l.data_id
      JOIN devices d ON d.device_id=s.device_id JOIN rooms r ON r.room_id=s.room_id WHERE ${scope} ORDER BY s.recorded_at DESC,s.data_id DESC LIMIT 20`, params)).rows.map((row) => ({ ...row, stale: Date.now() - row.recorded_at.getTime() > this.freshnessSeconds * 1000 }));
    return { rooms_count: rooms, device_counts: deviceCounts, unresolved_alert_counts: alerts, latest_telemetry: latest, latest_limit: 20, generated_at: new Date() };
  }
}
