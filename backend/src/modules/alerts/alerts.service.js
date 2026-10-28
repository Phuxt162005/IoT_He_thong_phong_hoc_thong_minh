import { AppError, requireFound } from "../../common/errors.js";
import { lockActor, requireRoomScope } from "../../common/authorization.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent } from "../../database/events.js";

const messages = { TEMP_HIGH: "Nhiệt độ vượt ngưỡng", HUMIDITY_HIGH: "Độ ẩm vượt ngưỡng", DEVICE_OFFLINE: "Thiết bị mất kết nối", DEVICE_FAULT: "Thiết bị gặp lỗi cần kiểm tra" };
const fires = (threshold, value) => threshold?.is_enabled && (threshold.operator === "GT" ? value > threshold.threshold_value : value >= threshold.threshold_value);

export class AlertsService {
  constructor({ pool, freshnessSeconds = 30 }) { this.pool = pool; this.freshnessSeconds = freshnessSeconds; }
  async thresholds(client, roomId) {
    return (await client.query(`SELECT DISTINCT ON(sensor_type,severity) * FROM alert_thresholds
      WHERE room_id=$1 OR room_id IS NULL ORDER BY sensor_type,severity,(room_id IS NOT NULL) DESC`, [roomId])).rows;
  }
  async getThresholds(user, id) { await requireRoomScope(this.pool, user, id); return this.thresholds(this.pool, id); }
  async updateThresholds(actor, id, values, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "thresholds:write");
      await requireRoomScope(client, actor, id);
      await client.query("SELECT room_id FROM rooms WHERE room_id=$1 FOR UPDATE", [id]);
      for (const value of values) {
        const min = value.sensor_type === "TEMPERATURE" ? -10 : 0;
        const max = value.sensor_type === "TEMPERATURE" ? 60 : 100;
        if (value.threshold_value < min || value.threshold_value > max || value.clear_value < min || value.clear_value > value.threshold_value) throw new AppError("INVALID_THRESHOLD", 400, "Ngưỡng và ngưỡng phục hồi không hợp lệ");
        await client.query(`INSERT INTO alert_thresholds(room_id,sensor_type,severity,operator,threshold_value,clear_value,is_enabled,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(room_id,sensor_type,severity) DO UPDATE SET operator=EXCLUDED.operator,
          threshold_value=EXCLUDED.threshold_value,clear_value=EXCLUDED.clear_value,is_enabled=EXCLUDED.is_enabled,updated_by=EXCLUDED.updated_by,updated_at=now()`, [id, value.sensor_type, value.severity, value.operator, value.threshold_value, value.clear_value, value.is_enabled, actor.user_id]);
      }
      const effective = await this.thresholds(client, id);
      for (const sensor of ["TEMPERATURE", "HUMIDITY"]) {
        const warning = effective.find((t) => t.sensor_type === sensor && t.severity === "WARNING");
        const critical = effective.find((t) => t.sensor_type === sensor && t.severity === "CRITICAL");
        if (warning?.is_enabled && critical?.is_enabled && critical.threshold_value < warning.threshold_value) throw new AppError("INVALID_THRESHOLD_ORDER", 400, "Ngưỡng CRITICAL phải không thấp hơn WARNING");
      }
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "ALERT_THRESHOLDS_UPDATE", targetType: "ROOM", targetId: id, requestId, details: { thresholds: values } });
      return effective;
    });
  }
  async event(client, alert, type = "alert.updated") {
    await enqueueIotEvent(client, type, { room_id: alert.room_id, device_id: alert.device_id, alert_id: alert.alert_id, alert_type: alert.alert_type, severity: alert.severity, status: alert.status });
  }
  async open(client, device, type) {
    return (await client.query("SELECT * FROM alerts WHERE device_id=$1 AND alert_type=$2 AND status<>'RESOLVED' FOR UPDATE", [device.device_id, type])).rows[0];
  }
  async raise(client, device, type, severity, value = null, { repeat = true } = {}) {
    let alert = await this.open(client, device, type);
    if (alert && !repeat) return alert;
    if (alert) {
      alert = (await client.query("UPDATE alerts SET severity=CASE WHEN severity='CRITICAL' OR $1::text='CRITICAL' THEN 'CRITICAL' ELSE 'WARNING' END,value=$2,occurrence_count=occurrence_count+1,last_occurred_at=now() WHERE alert_id=$3 RETURNING *", [severity, value, alert.alert_id])).rows[0];
      await this.event(client, alert);
    } else {
      alert = (await client.query("INSERT INTO alerts(device_id,room_id,alert_type,severity,value,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [device.device_id, device.room_id, type, severity, value, messages[type]])).rows[0];
      await writeAudit(client, { action: "ALERT_CREATE", targetType: "ALERT", targetId: alert.alert_id, details: { alert_type: type, severity, device_id: device.device_id } });
      await this.event(client, alert, "alert.created");
    }
    return alert;
  }
  async resolve(client, alert, reason, { actor = null, note = null, requestId = null } = {}) {
    const updated = (await client.query("UPDATE alerts SET status='RESOLVED',resolved_at=now(),resolved_reason=$1,resolved_by=$2,resolution_note=$3 WHERE alert_id=$4 AND status<>'RESOLVED' RETURNING *", [reason, actor?.user_id ?? null, note, alert.alert_id])).rows[0];
    if (!updated) return alert;
    await writeAudit(client, { actorType: actor ? "USER" : "SYSTEM", actorId: actor?.user_id ?? null, action: "ALERT_RESOLVE", targetType: "ALERT", targetId: alert.alert_id, requestId, details: { reason } });
    await this.event(client, updated);
    return updated;
  }
  async evaluateMetric(client, device, type, sensorType, value, thresholds) {
    const warning = thresholds.find((t) => t.sensor_type === sensorType && t.severity === "WARNING");
    const critical = thresholds.find((t) => t.sensor_type === sensorType && t.severity === "CRITICAL");
    const candidate = fires(critical, value) ? critical : fires(warning, value) ? warning : null;
    let alert = await this.open(client, device, type);
    if (!alert) { if (candidate) await this.raise(client, device, type, candidate.severity, value); return; }
    const active = alert.severity === "CRITICAL" ? critical : warning;
    if (!active?.is_enabled) {
      await this.resolve(client, alert, "THRESHOLD_DISABLED");
      if (candidate) await this.raise(client, device, type, candidate.severity, value);
      return;
    }
    const clearCount = !fires(active, value) && value <= active.clear_value ? alert.clear_count + 1 : 0;
    if (clearCount >= 3) {
      await this.resolve(client, alert, "AUTO_RECOVERED");
      if (candidate) await this.raise(client, device, type, candidate.severity, value);
      return;
    }
    if (candidate) alert = await this.raise(client, device, type, candidate.severity, value);
    const updated = (await client.query("UPDATE alerts SET clear_count=$1,value=$2 WHERE alert_id=$3 RETURNING *", [candidate?.severity === "CRITICAL" && alert.severity !== "CRITICAL" ? 0 : clearCount, value, alert.alert_id])).rows[0];
    if (!candidate) await this.event(client, updated);
  }
  async consumeTelemetry() {
    const pending = (await this.pool.query(`SELECT e.event_id,d.device_id FROM iot_events e JOIN sensor_data d ON d.data_id=e.data_id
      WHERE e.event_type='telemetry.stored' AND NOT EXISTS(SELECT 1 FROM iot_event_deliveries x WHERE x.event_id=e.event_id AND x.consumer='alerts') ORDER BY d.data_id LIMIT 100`)).rows;
    let processed = 0;
    for (const item of pending) await withTransaction(this.pool, async (client) => {
      const device = (await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [item.device_id])).rows[0];
      const event = (await client.query("SELECT * FROM iot_events WHERE event_id=$1 FOR UPDATE", [item.event_id])).rows[0];
      if (!event || (await client.query("SELECT event_id FROM iot_event_deliveries WHERE event_id=$1 AND consumer='alerts'", [item.event_id])).rowCount) return;
      const sample = (await client.query("SELECT * FROM sensor_data WHERE data_id=$1", [event.data_id])).rows[0];
      const room = device && (await client.query("SELECT status FROM rooms WHERE room_id=$1", [device.room_id])).rows[0];
      if (sample && device.lifecycle_status === "ACTIVE" && room?.status === "ACTIVE" && event.payload.eligible && Date.now() - sample.recorded_at.getTime() <= this.freshnessSeconds * 1000) {
        const thresholds = await this.thresholds(client, sample.room_id);
        await this.evaluateMetric(client, device, "TEMP_HIGH", "TEMPERATURE", sample.temperature, thresholds);
        await this.evaluateMetric(client, device, "HUMIDITY_HIGH", "HUMIDITY", sample.humidity, thresholds);
      }
      await client.query("INSERT INTO iot_event_deliveries(event_id,consumer) VALUES($1,'alerts') ON CONFLICT DO NOTHING", [item.event_id]);
      processed++;
    });
    return processed;
  }
  async scanDevices() {
    const devices = (await this.pool.query(`SELECT d.device_id FROM devices d WHERE d.lifecycle_status IN ('ACTIVE','FAULT')
      OR EXISTS(SELECT 1 FROM alerts a WHERE a.device_id=d.device_id AND a.status<>'RESOLVED') ORDER BY d.device_id LIMIT 1000`)).rows;
    for (const item of devices) await withTransaction(this.pool, async (client) => {
      const device = (await client.query("SELECT d.*,r.status AS room_status FROM devices d LEFT JOIN rooms r ON r.room_id=d.room_id WHERE d.device_id=$1 FOR UPDATE OF d", [item.device_id])).rows[0];
      if (!device) return;
      if (["REVOKED", "DECOMMISSIONED"].includes(device.lifecycle_status)) {
        const open = (await client.query("SELECT * FROM alerts WHERE device_id=$1 AND status<>'RESOLVED' FOR UPDATE", [device.device_id])).rows;
        for (const alert of open) await this.resolve(client, alert, "DEVICE_REVOKED");
        return;
      }
      const offline = ["ACTIVE", "FAULT"].includes(device.lifecycle_status) && device.room_status === "ACTIVE" && device.broker_sync_status === "SYNCED" && device.connection_status === "OFFLINE";
      if (offline) await this.raise(client, device, "DEVICE_OFFLINE", "WARNING", null, { repeat: false });
      else { const alert = await this.open(client, device, "DEVICE_OFFLINE"); if (alert) await this.resolve(client, alert, device.connection_status === "ONLINE" ? "AUTO_RECOVERED" : "LIFECYCLE_CHANGED"); }
      if (device.lifecycle_status === "FAULT") await this.raise(client, device, "DEVICE_FAULT", "CRITICAL", null, { repeat: false });
      else if (device.lifecycle_status === "ACTIVE") { const fault = await this.open(client, device, "DEVICE_FAULT"); if (fault) await this.resolve(client, fault, "AUTO_RECOVERED"); }
    });
    return devices.length;
  }
  async list(user, { page, page_size, room_id, status, severity, alert_type }) {
    const where = `WHERE ($1::boolean OR EXISTS(SELECT 1 FROM user_rooms ur WHERE ur.user_id=$2 AND ur.room_id=a.room_id))
      AND ($3::bigint IS NULL OR a.room_id=$3) AND ($4::text IS NULL OR a.status=$4) AND ($5::text IS NULL OR a.severity=$5) AND ($6::text IS NULL OR a.alert_type=$6)`;
    const params = [user.role === "ADMIN", user.user_id, room_id ?? null, status ?? null, severity ?? null, alert_type ?? null];
    const total = Number((await this.pool.query(`SELECT count(*) FROM alerts a ${where}`, params)).rows[0].count);
    const data = (await this.pool.query(`SELECT a.* FROM alerts a ${where} ORDER BY a.created_at DESC,a.alert_id DESC LIMIT $7 OFFSET $8`, [...params, page_size, (page - 1) * page_size])).rows;
    return { data, meta: { page, page_size, total } };
  }
  async act(user, id, action, reason, requestId) {
    return withTransaction(this.pool, async (client) => {
      const actor = await lockActor(client, user, "alerts:write");
      const target = requireFound((await client.query("SELECT device_id,room_id FROM alerts WHERE alert_id=$1", [id])).rows[0]);
      await requireRoomScope(client, actor, target.room_id);
      await client.query("SELECT device_id FROM devices WHERE device_id=$1 FOR UPDATE", [target.device_id]);
      const alert = requireFound((await client.query("SELECT * FROM alerts WHERE alert_id=$1 FOR UPDATE", [id])).rows[0]);
      if (action === "resolve") return this.resolve(client, alert, "MANUAL", { actor, note: reason, requestId });
      if (alert.status === "RESOLVED") throw new AppError("ALERT_ALREADY_RESOLVED", 409, "Cảnh báo đã đóng");
      if (alert.status === "ACKNOWLEDGED") return alert;
      const updated = (await client.query("UPDATE alerts SET status='ACKNOWLEDGED',acknowledged_at=now(),acknowledged_by=$1 WHERE alert_id=$2 RETURNING *", [actor.user_id, id])).rows[0];
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "ALERT_ACKNOWLEDGE", targetType: "ALERT", targetId: id, requestId });
      await this.event(client, updated);
      return updated;
    });
  }
  async get(user, id) {
    const alert = requireFound((await this.pool.query("SELECT * FROM alerts WHERE alert_id=$1", [id])).rows[0]);
    await requireRoomScope(this.pool, user, alert.room_id);
    return alert;
  }
}
