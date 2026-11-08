import type { DeviceRecord } from "./resource-types";

export function deviceBlockReason(
  device: DeviceRecord | undefined,
  allowed: string[],
  roomStatus?: string,
) {
  if (!device) return "Chọn thiết bị để thực hiện thao tác.";
  if (!allowed.includes(device.lifecycle_status))
    return "Trạng thái vòng đời hiện tại chỉ cho phép xem dữ liệu và lịch sử.";
  if ((device.room_status ?? roomStatus) !== "ACTIVE")
    return "Phòng đã ngừng hoạt động. Hãy kích hoạt phòng trước.";
  if (device.connection_status !== "ONLINE")
    return "Thiết bị chưa online. Hãy kiểm tra kết nối và heartbeat.";
  if (device.broker_sync_status !== "SYNCED")
    return "Credential của thiết bị chưa đồng bộ với MQTT broker.";
  return "";
}
