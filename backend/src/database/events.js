import { randomUUID } from "node:crypto";
import { writeAudit } from "./audit.js";

// Lưu sự kiện cùng transaction nghiệp vụ; trigger NOTIFY chỉ phát sau khi transaction commit.
// Consumer có thể đọc lại bản ghi này để tiếp tục xử lý sau khi tiến trình khởi động lại.
export async function enqueueIotEvent(client, type, payload, { dataId = null } = {}) {
  const eventId = randomUUID();
  await client.query("INSERT INTO iot_events(event_id,data_id,event_type,payload) VALUES($1,$2,$3,$4)", [eventId, dataId, type, payload]);
  return eventId;
}

export async function recordConnectionChange(client, device, status, reason) {
  // Chỉ ghi khi trạng thái thực sự đổi, tránh sinh audit/sự kiện lặp sau mỗi heartbeat.
  if (device.connection_status === status) return;
  await writeAudit(client, { action: "DEVICE_CONNECTION_CHANGE", targetType: "DEVICE", targetId: device.device_id, details: { before: device.connection_status, status, reason } });
  return enqueueIotEvent(client, "device.status_changed", { device_id: device.device_id, room_id: device.room_id, before: device.connection_status, status, lifecycle_status: device.lifecycle_status, reason });
}
