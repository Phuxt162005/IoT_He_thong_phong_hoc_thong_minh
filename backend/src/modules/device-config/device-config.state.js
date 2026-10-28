import { writeAudit } from "../../database/audit.js";
import { enqueueIotEvent } from "../../database/events.js";

export async function finishConfig(client, config, status, errorCode) {
  const result = (await client.query("UPDATE device_configs SET status=$1,error_code=$2 WHERE config_id=$3 AND status='PENDING' RETURNING *", [status, errorCode, config.config_id])).rows[0];
  if (!result) return null;
  await client.query("UPDATE device_settings SET last_error_code=$1,updated_at=now() WHERE device_id=$2 AND desired_version=$3", [errorCode, config.device_id, config.version]);
  await writeAudit(client, { action: "CONFIG_RESULT", targetType: "CONFIG", targetId: config.config_id, details: { status, error_code: errorCode } });
  await enqueueIotEvent(client, "config.updated", { config_id: config.config_id, device_id: config.device_id, room_id: config.room_id, status, version: config.version });
  return result;
}

export async function cancelPendingDeviceConfigs(client, deviceId, code) {
  const rows = (await client.query("SELECT * FROM device_configs WHERE device_id=$1 AND status='PENDING' ORDER BY version FOR UPDATE", [deviceId])).rows;
  for (const config of rows) {
    const expired = config.timeout_at <= new Date();
    await finishConfig(client, config, expired ? "TIMEOUT" : "FAILED", expired ? "CONFIG_TIMEOUT" : code);
  }
  return rows.length;
}

export async function resetConfigForSession(client, device) {
  await cancelPendingDeviceConfigs(client, device.device_id, "DEVICE_RECONNECTED");
  await client.query("UPDATE device_settings SET applied_version=0,applied_settings='{}',last_applied_at=NULL,updated_at=now() WHERE device_id=$1", [device.device_id]);
}
