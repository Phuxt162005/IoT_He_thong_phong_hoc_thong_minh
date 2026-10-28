import { enqueueIotEvent } from "../../database/events.js";
import { writeAudit } from "../../database/audit.js";
import { AppError } from "../../common/errors.js";

export async function finishCommand(client, command, status, errorCode, { ackPayload = null } = {}) {
  const result = await client.query(`UPDATE commands SET status=$1::text,error_code=$2,ack_payload=coalesce($3,ack_payload),
    acked_at=CASE WHEN $1::text IN ('SUCCESS','FAILED') AND $3::jsonb IS NOT NULL THEN now() ELSE acked_at END
    WHERE command_id=$4 AND status='PENDING' RETURNING *`, [status, errorCode, ackPayload, command.command_id]);
  if (!result.rowCount) return null;
  const updated = result.rows[0];
  await client.query("UPDATE device_shadows SET last_command_error=$1,updated_at=now() WHERE device_id=$2 AND desired_version=$3", [errorCode, command.device_id, command.shadow_version]);
  await writeAudit(client, { action: "COMMAND_RESULT", targetType: "COMMAND", targetId: command.command_id, details: { status, error_code: errorCode } });
  await enqueueIotEvent(client, "command.updated", { device_id: command.device_id, room_id: command.room_id, command_id: command.command_id, status, error_code: errorCode });
  return updated;
}

export async function cancelPendingDeviceCommands(client, deviceId, errorCode, source = null) {
  const pending = (await client.query("SELECT * FROM commands WHERE device_id=$1 AND status='PENDING' AND ($2::text IS NULL OR source=$2) ORDER BY created_at FOR UPDATE", [deviceId, source])).rows;
  for (const command of pending) {
    const expired = command.timeout_at <= new Date();
    await finishCommand(client, command, expired ? "TIMEOUT" : "FAILED", expired ? "ACK_TIMEOUT" : errorCode);
  }
  return pending.length;
}

export async function resetReportedForSession(client, device, sessionId) {
  if (device.device_type !== "CONTROL_NODE") return;
  await client.query("UPDATE actuators SET current_state='UNKNOWN',reported_version=0,reported_session_id=$1,reported_timestamp_ms=0,updated_at=now() WHERE device_id=$2", [sessionId, device.device_id]);
  await client.query("UPDATE device_shadows SET reported_state='{\"light\":\"UNKNOWN\",\"fan\":\"UNKNOWN\"}',reported_version=0,last_reported_at=NULL,updated_at=now() WHERE device_id=$1", [device.device_id]);
  await cancelPendingDeviceCommands(client, device.device_id, "DEVICE_RECONNECTED");
  await enqueueIotEvent(client, "actuator.state_changed", { device_id: device.device_id, room_id: device.room_id, reported_state: { light: "UNKNOWN", fan: "UNKNOWN" } });
}

export async function applyReportedState(client, device, { session_id, shadow_version, timestamp, reported_state }) {
  if (device.session_id !== session_id) throw new AppError("DEVICE_SESSION_MISMATCH", 409, "Phản hồi không thuộc phiên hiện tại");
  const shadow = (await client.query("SELECT * FROM device_shadows WHERE device_id=$1 FOR UPDATE", [device.device_id])).rows[0];
  if (!shadow || shadow_version > shadow.desired_version) throw new AppError("INVALID_SHADOW_VERSION", 409, "Version trạng thái không hợp lệ");
  let changed = 0;
  for (const [name, value] of Object.entries(reported_state)) {
    const result = await client.query(`UPDATE actuators SET current_state=$1,reported_version=$2,reported_session_id=$3,reported_timestamp_ms=$4,updated_at=now()
      WHERE device_id=$5 AND actuator_type=$6 AND (reported_session_id IS DISTINCT FROM $3 OR reported_version<$2 OR (reported_version=$2 AND reported_timestamp_ms<$4))`,
      [value, shadow_version, session_id, timestamp, device.device_id, name.toUpperCase()]);
    changed += result.rowCount;
  }
  if (!changed) return false;
  const state = (await client.query("SELECT jsonb_object_agg(lower(actuator_type),current_state) AS reported,max(reported_version) AS version FROM actuators WHERE device_id=$1", [device.device_id])).rows[0];
  await client.query("UPDATE device_shadows SET reported_state=$1,reported_version=$2,last_reported_at=now(),updated_at=now() WHERE device_id=$3", [state.reported, state.version, device.device_id]);
  await enqueueIotEvent(client, "actuator.state_changed", { device_id: device.device_id, room_id: device.room_id, reported_state: state.reported, reported_version: state.version });
  return true;
}
