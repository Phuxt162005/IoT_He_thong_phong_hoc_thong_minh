import { randomBytes, randomUUID } from "node:crypto";
import { AppError, requireFound } from "../../common/errors.js";
import { lockActor } from "../../common/authorization.js";
import { hashPassword } from "../../common/passwords.js";
import { SecretBox } from "../../common/secret-box.js";
import { withTransaction } from "../../database/pool.js";
import { writeAudit } from "../../database/audit.js";
import { transitionDevice } from "../devices/device-lifecycle.js";
import { requireDeviceScope } from "../devices/devices.service.js";
import { recordConnectionChange } from "../../database/events.js";
import { cancelPendingDeviceCommands } from "../commands/command-state.js";
import { cancelPendingDeviceConfigs } from "../device-config/device-config.state.js";

const safeOperation = (op) => ({ operation_id: op.operation_id, operation: op.operation, status: op.status, attempts: op.attempts, last_error_code: op.last_error_code, applied_at: op.applied_at });

export class DeviceCredentialsService {
  constructor({ pool, admin, secretKey, mqttUrl, reservedUsernames = ["admin", "backend_service"], heartbeatTimeoutSeconds = 30 }) {
    this.pool = pool; this.admin = admin; this.box = new SecretBox(secretKey); this.mqttUrl = mqttUrl; this.reservedUsernames = reservedUsernames;
    this.heartbeatTimeoutSeconds = heartbeatTimeoutSeconds;
  }
  async issue(actor, id, operation, { reason, confirmed }, requestId) {
    const secret = randomBytes(32).toString("hex");
    const hash = await hashPassword(secret);
    const operationId = randomUUID();
    const credentialId = randomUUID();
    const result = await withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      let device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      if (this.reservedUsernames.includes(device.device_code)) throw new AppError("DEVICE_CODE_RESERVED", 409, "Mã thiết bị trùng tài khoản dịch vụ");
      const room = requireFound((await client.query("SELECT * FROM rooms WHERE room_id=$1 FOR SHARE", [device.room_id])).rows[0], "Thiết bị chưa được gán phòng");
      if (room.status !== "ACTIVE") throw new AppError("ROOM_INACTIVE", 409, "Phòng đã ngừng sử dụng");
      if (operation === "PROVISION") {
        if (device.lifecycle_status === "REVOKED" && !confirmed) throw new AppError("CONFIRMATION_REQUIRED", 400, "Cần xác nhận cấp lại thiết bị đã thu hồi");
        device = await transitionDevice(client, device, "PROVISIONED", { actorId: actor.user_id, reason, requestId, action: "DEVICE_PROVISION" });
      } else if (!["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"].includes(device.lifecycle_status)) {
        throw new AppError("INVALID_DEVICE_TRANSITION", 409, "Không thể đổi credential ở trạng thái hiện tại");
      }
      await client.query("UPDATE broker_operations SET status='SUPERSEDED',secret_encrypted=NULL WHERE device_id=$1 AND status='PENDING'", [id]);
      await client.query("UPDATE device_credentials SET status='REVOKED',revoked_at=now() WHERE device_id=$1 AND status='ACTIVE'", [id]);
      const version = Number((await client.query("SELECT coalesce(max(version),0)+1 AS version FROM device_credentials WHERE device_id=$1", [id])).rows[0].version);
      await client.query("INSERT INTO device_credentials(credential_id,device_id,version,mqtt_username,secret_hash,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [credentialId, id, version, device.device_code, hash]);
      await client.query("INSERT INTO broker_operations(operation_id,device_id,credential_id,operation,secret_encrypted) VALUES($1,$2,$3,$4,$5)", [operationId, id, credentialId, operation, this.box.seal(secret, `${id}:${operationId}`)]);
      await client.query("UPDATE devices SET broker_sync_status='PENDING',connection_status='UNKNOWN',last_seen=NULL,last_heartbeat_at=NULL,session_id=NULL WHERE device_id=$1", [id]);
      await recordConnectionChange(client, device, "UNKNOWN", "CREDENTIAL_ISSUE");
      await cancelPendingDeviceCommands(client, id, "CREDENTIAL_CHANGED");
      await cancelPendingDeviceConfigs(client, id, "CREDENTIAL_CHANGED");
      await writeAudit(client, { actorType: "USER", actorId: actor.user_id, action: "DEVICE_CREDENTIAL_ISSUE", targetType: "DEVICE", targetId: id, requestId, details: { credential_id: credentialId, version, operation } });
      return { username: device.device_code, client_id: device.device_code, room_code: room.room_code, version };
    });
    const op = await this.reconcileOperation(operationId);
    if (op.status === "SUPERSEDED") throw new AppError("OPERATION_SUPERSEDED", 409, "Thao tác đã được thay thế bởi thay đổi mới");
    return { operation: op, credentials: { credential_id: credentialId, ...result, password: secret, mqtt_url: this.mqttUrl } };
  }
  async revoke(actor, id, { reason, confirmed }, requestId) {
    if (!confirmed) throw new AppError("CONFIRMATION_REQUIRED", 400, "Cần xác nhận thu hồi thiết bị");
    const operationId = randomUUID();
    await withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      await transitionDevice(client, device, "REVOKED", { actorId: actor.user_id, reason, requestId, action: "DEVICE_REVOKE" });
      await client.query("UPDATE device_credentials SET status='REVOKED',revoked_at=now() WHERE device_id=$1 AND status='ACTIVE'", [id]);
      await client.query("UPDATE broker_operations SET status='SUPERSEDED',secret_encrypted=NULL WHERE device_id=$1 AND status='PENDING'", [id]);
      await client.query("INSERT INTO broker_operations(operation_id,device_id,operation) VALUES($1,$2,'REVOKE')", [operationId, id]);
      await client.query("UPDATE devices SET broker_sync_status='PENDING' WHERE device_id=$1", [id]);
    });
    return { operation: await this.reconcileOperation(operationId) };
  }
  async reconcileOperation(operationId) {
    const found = requireFound((await this.pool.query("SELECT device_id FROM broker_operations WHERE operation_id=$1", [operationId])).rows[0]);
    return withTransaction(this.pool, async (client) => {
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [found.device_id])).rows[0]);
      const op = requireFound((await client.query("SELECT * FROM broker_operations WHERE operation_id=$1 FOR UPDATE", [operationId])).rows[0]);
      if (op.status !== "PENDING") return safeOperation(op);
      try {
        if (op.operation === "REVOKE") await this.admin.revoke(device.device_code);
        else await this.admin.setIdentity({ username: device.device_code, password: this.box.open(op.secret_encrypted, `${device.device_id}:${op.operation_id}`), deviceType: device.device_type });
      } catch (error) {
        const code = ["BROKER_UNAVAILABLE", "BROKER_OPERATION_FAILED"].includes(error.code) ? error.code : "BROKER_SYNC_FAILED";
        const retry = await client.query("UPDATE broker_operations SET attempts=attempts+1,last_error_code=$1,next_retry_at=now()+interval '5 seconds' WHERE operation_id=$2 RETURNING *", [code, operationId]);
        return safeOperation(retry.rows[0]);
      }
      const applied = (await client.query("UPDATE broker_operations SET status='APPLIED',attempts=attempts+1,secret_encrypted=NULL,last_error_code=NULL,applied_at=now() WHERE operation_id=$1 RETURNING *", [operationId])).rows[0];
      if (op.credential_id) await client.query("UPDATE device_credentials SET synced_at=now() WHERE credential_id=$1", [op.credential_id]);
      await client.query("UPDATE devices SET broker_sync_status='SYNCED' WHERE device_id=$1", [device.device_id]);
      await writeAudit(client, { action: "BROKER_SYNC_APPLIED", targetType: "DEVICE", targetId: device.device_id, details: { operation_id: operationId, operation: op.operation } });
      return safeOperation(applied);
    });
  }
  async processPending() {
    const rows = (await this.pool.query("SELECT operation_id FROM broker_operations WHERE status='PENDING' AND next_retry_at<=now() ORDER BY created_at LIMIT 5")).rows;
    for (const row of rows) await this.reconcileOperation(row.operation_id);
    return rows.length;
  }
  async activate(actor, id, { reason }, requestId) {
    return withTransaction(this.pool, async (client) => {
      await lockActor(client, actor, "devices:write");
      const device = requireFound((await client.query("SELECT * FROM devices WHERE device_id=$1 FOR UPDATE", [id])).rows[0]);
      const credential = (await client.query("SELECT credential_id FROM device_credentials WHERE device_id=$1 AND status='ACTIVE' AND synced_at IS NOT NULL", [id])).rows[0];
      const room = (await client.query("SELECT * FROM rooms WHERE room_id=$1 FOR SHARE", [device.room_id])).rows[0];
      if (!credential || device.broker_sync_status !== "SYNCED") throw new AppError("CREDENTIAL_NOT_READY", 409, "Credential chưa đồng bộ broker");
      if (!room || room.status !== "ACTIVE") throw new AppError("ROOM_INACTIVE", 409, "Phòng chưa hoạt động");
      const session = (await client.query("SELECT last_heartbeat_at FROM device_sessions WHERE device_id=$1 AND session_id=$2 AND closed_at IS NULL", [id, device.session_id])).rows[0];
      if (device.connection_status !== "ONLINE" || !session?.last_heartbeat_at || Date.now() - session.last_heartbeat_at.getTime() > this.heartbeatTimeoutSeconds * 1000) throw new AppError("DEVICE_OFFLINE", 409, "Cần heartbeat mới từ phiên thiết bị hiện tại");
      return transitionDevice(client, device, "ACTIVE", { actorId: actor.user_id, reason, requestId, action: "DEVICE_ACTIVATE" });
    });
  }
  async status(user, id) {
    await requireDeviceScope(this.pool, user, id);
    const operations = (await this.pool.query("SELECT operation_id,operation,status,attempts,last_error_code,applied_at FROM broker_operations WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20", [id])).rows;
    return { broker_sync_status: (await this.pool.query("SELECT broker_sync_status FROM devices WHERE device_id=$1", [id])).rows[0].broker_sync_status, operations };
  }
}
