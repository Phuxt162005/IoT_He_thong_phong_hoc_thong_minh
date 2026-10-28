import { AppError } from "../../common/errors.js";
import { writeAudit } from "../../database/audit.js";
import { recordConnectionChange } from "../../database/events.js";
import { cancelPendingDeviceCommands } from "../commands/command-state.js";

export const transitions = Object.freeze({
  REGISTERED: ["PROVISIONED", "DECOMMISSIONED"],
  PROVISIONED: ["ACTIVE", "REVOKED"],
  ACTIVE: ["FAULT", "MAINTENANCE", "REVOKED"],
  FAULT: ["ACTIVE", "MAINTENANCE", "REVOKED"],
  MAINTENANCE: ["ACTIVE", "REVOKED"],
  REVOKED: ["PROVISIONED", "DECOMMISSIONED"],
  DECOMMISSIONED: [],
});

export async function recordLifecycle(client, device, from, to, { actorType = "USER", actorId = null, reason, requestId, action }) {
  await client.query("INSERT INTO device_lifecycle_events(device_id,from_status,to_status,reason,actor_type,actor_id) VALUES($1,$2,$3,$4,$5,$6)", [device.device_id, from, to, reason, actorType, actorId]);
  await writeAudit(client, { actorType, actorId, action, targetType: "DEVICE", targetId: device.device_id, requestId, details: { from, to, reason } });
}

export async function transitionDevice(client, device, to, context) {
  if (!transitions[device.lifecycle_status]?.includes(to)) throw new AppError("INVALID_DEVICE_TRANSITION", 409, "Chuyển trạng thái thiết bị không hợp lệ");
  const result = await client.query(`UPDATE devices SET lifecycle_status=$1::text,
    connection_status=CASE WHEN $1::text IN ('REVOKED','DECOMMISSIONED') THEN 'OFFLINE' WHEN $1::text='PROVISIONED' THEN 'UNKNOWN' ELSE connection_status END,
    updated_at=now() WHERE device_id=$2 AND lifecycle_status=$3 RETURNING *`, [to, device.device_id, device.lifecycle_status]);
  if (!result.rowCount) throw new AppError("DEVICE_STATE_CONFLICT", 409, "Trạng thái thiết bị đã thay đổi");
  await recordLifecycle(client, result.rows[0], device.lifecycle_status, to, context);
  await recordConnectionChange(client, { ...device, lifecycle_status: to }, result.rows[0].connection_status, context.action);
  if (["FAULT", "MAINTENANCE", "REVOKED", "DECOMMISSIONED"].includes(to)) await cancelPendingDeviceCommands(client, device.device_id, `DEVICE_${to}`);
  return result.rows[0];
}
