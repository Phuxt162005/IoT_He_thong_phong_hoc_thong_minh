import type { Alert, Command, Device, LatestTelemetry, Room, User } from '../types';
export const users: User[] = [
  { id: 'u1', username: 'admin', display_name: 'Quản trị viên', role: 'ADMIN', status: 'ACTIVE' },
  { id: 'u2', username: 'operator', display_name: 'Vận hành viên', role: 'OPERATOR', status: 'ACTIVE' },
  { id: 'u3', username: 'viewer', display_name: 'Người xem', role: 'VIEWER', status: 'ACTIVE' },
];
export const rooms: Room[] = [{ id: 'r1', room_code: 'A101', room_name: 'Phòng học A101', status: 'ACTIVE', device_count: 2 }, { id: 'r2', room_code: 'B202', room_name: 'Phòng thí nghiệm B202', status: 'ACTIVE', device_count: 0 }];
export const devices: Device[] = [
  { id: 'd1', device_code: 'ESP32_SENSOR_01', device_type: 'SENSOR_NODE', room_id: 'r1', room_name: 'Phòng học A101', lifecycle_status: 'ACTIVE', connection_status: 'ONLINE', firmware_version: '1.4.2', last_seen: new Date().toISOString(), wifi_rssi_dbm: -48, free_heap_bytes: 124800, uptime_seconds: 423901 },
  { id: 'd2', device_code: 'ESP32_CTRL_01', device_type: 'CONTROL_NODE', room_id: 'r1', room_name: 'Phòng học A101', lifecycle_status: 'ACTIVE', connection_status: 'ONLINE', firmware_version: '1.4.2', last_seen: new Date().toISOString(), wifi_rssi_dbm: -52, free_heap_bytes: 119200, uptime_seconds: 423880 },
];
export const lifecycleEvents = [{ id: 'le1', from_status: null, to_status: 'REGISTERED', created_at: new Date(Date.now() - 86400000).toISOString(), reason: 'Đăng ký thiết bị' }];
export const latest: LatestTelemetry = { temperature: 27.4, humidity: 61, lux: 438, occupancy: true, updated_at: new Date().toISOString(), light_state: 'ON', fan_state: 'OFF' };
export const alerts: Alert[] = [
  { id: 'a1', alert_type: 'TEMP_HIGH', severity: 'WARNING', status: 'OPEN', room_name: 'Phòng học A101', device_code: 'ESP32_SENSOR_01', value: 31.2, occurrence_count: 3, created_at: new Date(Date.now() - 12 * 60000).toISOString() },
  { id: 'a2', alert_type: 'DEVICE_OFFLINE', severity: 'CRITICAL', status: 'RESOLVED', room_name: 'Phòng thí nghiệm B202', occurrence_count: 1, created_at: new Date(Date.now() - 3600000).toISOString() },
];
export const commands: Command[] = [{ id: 'cmd-01', actuator_type: 'LIGHT', target_state: 'ON', status: 'SUCCESS', created_at: new Date(Date.now() - 900000).toISOString(), ack_at: new Date(Date.now() - 899000).toISOString() }, { id: 'cmd-02', actuator_type: 'FAN', target_state: 'ON', status: 'TIMEOUT', created_at: new Date(Date.now() - 3600000).toISOString() }];
export const chartData = Array.from({ length: 24 }, (_, i) => ({ time: `${i}:00`, temperature: +(25 + Math.sin(i / 3) * 2).toFixed(1), lux: Math.round(300 + Math.cos(i / 2) * 100) }));
