import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { withTransaction } from "../../database/pool.js";
import { recordConnectionChange } from "../../database/events.js";
import { resetReportedForSession } from "../commands/command-state.js";
import { reportedPatchSchema, shadowVersionSchema } from "../commands/command-schemas.js";
import { resetConfigForSession } from "../device-config/device-config.state.js";

const code = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const timestamp = z.number().int().min(0).max(8640000000000000);
const heartbeat = z.object({ msg_id: z.string().min(1).max(64), device_id: code, room_id: code, session_id: sessionId, timestamp, uptime_seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), free_heap_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), wifi_rssi_dbm: z.number().int().min(-127).max(0), firmware_version: z.string().min(1).max(64).optional() }).strict();
const statusMessage = z.object({ device_id: code, room_id: code, session_id: sessionId, timestamp: timestamp.optional(), status: z.enum(["ONLINE", "OFFLINE"]), reason: z.string().min(1).max(64).optional(), reported_state: reportedPatchSchema.optional(), shadow_version: shadowVersionSchema.optional() }).strict().refine((v) => (v.status === "OFFLINE" || v.timestamp !== undefined) && ((v.reported_state === undefined) === (v.shadow_version === undefined)));
const allowed = ["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"];

export class DevicePresenceService {
  constructor({ pool, timeoutSeconds = 30 }) { this.pool = pool; this.timeoutSeconds = timeoutSeconds; }
  async handle(envelope) {
    if (!["heartbeat", "status"].includes(envelope.kind)) return;
    const parsed = (envelope.kind === "heartbeat" ? heartbeat : statusMessage).safeParse(envelope.payload);
    if (!parsed.success || parsed.data.device_id !== envelope.deviceCode || parsed.data.room_id !== envelope.roomCode) throw new AppError("INVALID_HEARTBEAT", 400, "Heartbeat/status không hợp lệ hoặc không khớp topic");
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      const device = (await client.query(`SELECT d.* FROM devices d JOIN rooms r ON r.room_id=d.room_id
        WHERE d.device_code=$1 AND r.room_code=$2 FOR UPDATE OF d`, [envelope.deviceCode, envelope.roomCode])).rows[0];
      if (!device || !allowed.includes(device.lifecycle_status) || device.broker_sync_status !== "SYNCED") return false;
      const credential = await client.query("SELECT credential_id FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [device.device_id]);
      if (!credential.rowCount) return false;
      const known = (await client.query("SELECT * FROM device_sessions WHERE device_id=$1 AND session_id=$2", [device.device_id, data.session_id])).rows[0];
      if (data.status === "OFFLINE") {
        if (!known || known.closed_at || device.session_id !== data.session_id) return false;
        await client.query("UPDATE device_sessions SET closed_at=now() WHERE device_id=$1 AND session_id=$2", [device.device_id, data.session_id]);
        await client.query("UPDATE devices SET connection_status='OFFLINE',updated_at=now() WHERE device_id=$1", [device.device_id]);
        await recordConnectionChange(client, device, "OFFLINE", "LWT");
        return true;
      }
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
      if (data.timestamp < now.getTime() - this.timeoutSeconds * 1000 || data.timestamp > now.getTime() + 300000) return false;
      if (known?.closed_at || (known && device.session_id !== data.session_id)) return false;
      if (known) {
        if (envelope.kind === "heartbeat") {
          if (known.last_msg_id === data.msg_id || (known.last_uptime_seconds !== null && data.uptime_seconds <= Number(known.last_uptime_seconds))) return false;
        } else if (data.timestamp <= Number(known.last_timestamp_ms)) return false;
      } else {
        if (device.session_id) {
          const currentSession = (await client.query("SELECT last_timestamp_ms FROM device_sessions WHERE device_id=$1 AND session_id=$2", [device.device_id, device.session_id])).rows[0];
          if (currentSession && data.timestamp <= Number(currentSession.last_timestamp_ms)) return false;
        }
        await client.query("UPDATE device_sessions SET closed_at=now() WHERE device_id=$1 AND closed_at IS NULL", [device.device_id]);
        await client.query("INSERT INTO device_sessions(device_id,session_id,last_timestamp_ms) VALUES($1,$2,$3)", [device.device_id, data.session_id, data.timestamp]);
        await client.query("UPDATE devices SET last_heartbeat_at=NULL WHERE device_id=$1", [device.device_id]);
        await resetReportedForSession(client, device, data.session_id);
        await resetConfigForSession(client, device);
      }
      const heartbeatAt = envelope.kind === "heartbeat" ? now : null;
      await client.query("UPDATE device_sessions SET last_msg_id=$1,last_timestamp_ms=$2,last_uptime_seconds=coalesce($3,last_uptime_seconds),last_heartbeat_at=coalesce($4,last_heartbeat_at) WHERE device_id=$5 AND session_id=$6", [data.msg_id ?? null, data.timestamp, data.uptime_seconds ?? null, heartbeatAt, device.device_id, data.session_id]);
      await client.query(`UPDATE devices SET connection_status='ONLINE',session_id=$1,last_seen=$2,
        last_rssi_dbm=coalesce($3,last_rssi_dbm),last_free_heap_bytes=coalesce($4,last_free_heap_bytes),last_uptime_seconds=coalesce($5,last_uptime_seconds),firmware_version=coalesce($6,firmware_version),updated_at=$2
        ,last_heartbeat_at=coalesce($7,last_heartbeat_at) WHERE device_id=$8`, [data.session_id, now, data.wifi_rssi_dbm ?? null, data.free_heap_bytes ?? null, data.uptime_seconds ?? null, data.firmware_version ?? null, heartbeatAt, device.device_id]);
      await recordConnectionChange(client, device, "ONLINE", envelope.kind === "heartbeat" ? "HEARTBEAT" : "STATUS_ONLINE");
      return true;
    });
  }
  async scanOffline() {
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query(`SELECT * FROM devices WHERE lifecycle_status=ANY($1::text[]) AND connection_status='ONLINE'
        AND last_seen < clock_timestamp()-($2::double precision * interval '1 second') ORDER BY device_id LIMIT 100 FOR UPDATE SKIP LOCKED`, [allowed, this.timeoutSeconds]);
      for (const device of expired.rows) {
        await client.query("UPDATE devices SET connection_status='OFFLINE',updated_at=now() WHERE device_id=$1 AND connection_status='ONLINE'", [device.device_id]);
        await recordConnectionChange(client, device, "OFFLINE", "HEARTBEAT_TIMEOUT");
      }
      return expired.rowCount;
    });
  }
}

export function bindPresence(runtime, presence) {
  const handler = (envelope) => presence.handle(envelope);
  runtime.on("device-message", handler);
  return () => runtime.off("device-message", handler);
}
