import axios from 'axios';
import type { Alert, ApiResponse, Command, DashboardData, DeviceShadow, CreateUserInput, Device, DeviceAction, LatestTelemetry, RegisterInput, Room, UpdateUserInput, User, UserListQuery, UserPage } from '../types';
import { useAuthStore } from '../store/auth';
import { mockApi } from './mockApi';

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api/v1', timeout: 10000 });
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = ['Bearer', token].join(' ');
  return config;
});
api.interceptors.response.use((response) => response, (error) => {
  if (error.response?.status === 401 && !['/auth/login', '/auth/register', '/auth/change-password'].includes(error.config?.url)) useAuthStore.getState().logout();
  return Promise.reject(error);
});
export async function request<T>(promise: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  return (await promise).data.data;
}
async function list<T>(promise: Promise<{ data: ApiResponse<T[] | { items: T[] }> }>): Promise<T[]> {
  const data = await request(promise);
  return Array.isArray(data) ? data : data.items;
}
const mock = import.meta.env.VITE_USE_MOCK === 'true';
type LoginResponse = { access_token: string; user: User };
function normalizeUser(user: User & { user_id?: string }): User { return { ...user, id: user.id || user.user_id || '' }; }
export function apiErrorMessage(error: unknown, fallback = 'Không thể thực hiện thao tác. Vui lòng thử lại.') {
  if (axios.isAxiosError(error)) return error.response?.data?.error?.message || (error.code === 'ERR_NETWORK' ? 'Không kết nối được backend. Vui lòng kiểm tra máy chủ.' : fallback);
  return error instanceof Error ? error.message : fallback;
}
function normalizeDevice(device: Device & { device_id?: string; last_rssi_dbm?: number; last_free_heap_bytes?: number; last_uptime_seconds?: number; last_seen?: string; room_code?: string }): Device {
  return { ...device, id: device.id || device.device_id || '', wifi_rssi_dbm: device.wifi_rssi_dbm ?? device.last_rssi_dbm, free_heap_bytes: device.free_heap_bytes ?? device.last_free_heap_bytes, uptime_seconds: device.uptime_seconds ?? device.last_uptime_seconds, room_name: device.room_name || device.room_code };
}
async function normalizedDevices(promise: Promise<{ data: ApiResponse<Device[] | { items: Device[] }> }>) { return (await list<Device>(promise)).map(normalizeDevice); }
function normalizeRoom(room: Room & { room_id?: string }): Room { return { ...room, id: room.id || room.room_id || '' }; }
function normalizeAlert(alert: Alert & { alert_id?: string }): Alert { return { ...alert, id: alert.id || alert.alert_id || '' }; }
function normalizeCommand(command: Command & { command_id?: string }): Command { const desired = command.desired_state; const actuator = desired?.light !== undefined ? 'LIGHT' : desired?.fan !== undefined ? 'FAN' : command.actuator_type; return { ...command, id: command.id || command.command_id || '', actuator_type: actuator, target_state: desired?.light ?? desired?.fan ?? command.target_state }; }
export const apiService = {
  login: async (username: string, password: string) => {
    const session = mock ? await mockApi.login(username, password) : await request<LoginResponse>(api.post('/auth/login', { username, password }));
    return { ...session, user: normalizeUser(session.user) };
  },
  register: (input: RegisterInput) => mock ? mockApi.register(input) : request<User>(api.post('/auth/register', input)).then(normalizeUser),
  me: () => mock ? mockApi.me() : request<User>(api.get('/auth/me')).then(normalizeUser),
  logout: () => mock ? Promise.resolve() : request(api.post('/auth/logout')),
  changePassword: (current_password: string, new_password: string) => mock ? mockApi.changePassword(current_password, new_password) : request(api.post('/auth/change-password', { current_password, new_password })),
  rooms: () => mock ? mockApi.rooms() : list<Room>(api.get('/rooms')).then((items) => items.map(normalizeRoom)),
  devices: () => mock ? mockApi.devices() : normalizedDevices(api.get('/devices')),
  room: (id: string) => mock ? mockApi.rooms().then((rooms) => rooms.find((room) => room.id === id)) : request<Room>(api.get(`/rooms/${id}`)).then(normalizeRoom),
  createRoom: (payload: { room_code: string; room_name: string }) => mock ? mockApi.rooms().then(() => ({ id: `r-${Date.now()}`, ...payload, status: 'ACTIVE' as const })) : request<Room>(api.post('/rooms', payload)).then(normalizeRoom),
  device: (id: string) => mock ? mockApi.device(id) : request<Device>(api.get(`/devices/${id}`)).then(normalizeDevice),
  latest: async (roomId: string) => {
    if (mock) return mockApi.latest(roomId);
    const result = await request<Array<LatestTelemetry & { recorded_at?: string; stale?: boolean }>>(api.get(`/rooms/${roomId}/telemetry/latest`, { params: { page: 1, page_size: 1 } }));
    const row = result[0];
    return row ? { ...row, updated_at: row.recorded_at, stale: row.stale } : {};
  },
  telemetry: (roomId: string, params: { from: string; to: string; device_id?: string; metric?: string; interval?: string }) => mock ? mockApi.chart() as Promise<Record<string, unknown>[]> : request<Record<string, unknown>[]>(api.get(`/rooms/${roomId}/telemetry`, { params })),
  telemetryExport: (roomId: string, params: { from: string; to: string; device_id?: string }) => api.get(`/rooms/${roomId}/telemetry/export`, { params, responseType: 'blob' }),
  dashboard: async (roomId?: string): Promise<DashboardData> => {
    if (mock) return { ...await mockApi.latest(roomId || 'r1'), telemetry: await mockApi.chart(), open_alerts: await mockApi.alerts(), recent_commands: roomId ? await mockApi.commands(roomId) : [] };
    const snapshot = await request<{ latest_telemetry: Array<LatestTelemetry & { recorded_at: string }> }>(api.get('/dashboard', { params: roomId ? { room_id: roomId } : undefined }));
    if (!roomId) return { ...snapshot.latest_telemetry[0], updated_at: snapshot.latest_telemetry[0]?.recorded_at };
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 86400000).toISOString();
    const [telemetry, alerts, devices] = await Promise.all([
      request<LatestTelemetry[]>(api.get(`/rooms/${roomId}/telemetry`, { params: { from, to, page_size: 100 } })),
      apiService.alerts({ room_id: roomId, status: 'OPEN' }),
      normalizedDevices(api.get('/devices', { params: { room_id: roomId } })),
    ]);
    const control = devices.find(device => device.device_type === 'CONTROL_NODE');
    const [shadow, commands] = control ? await Promise.all([apiService.shadow(control.id), apiService.commands(control.id)]) : [undefined, []];
    const latest = snapshot.latest_telemetry[0];
    return { ...latest, updated_at: latest?.recorded_at, telemetry: telemetry.slice().reverse(), open_alerts: alerts, recent_commands: commands, devices, light_state: shadow?.light, fan_state: shadow?.fan };
  },
  shadow: async (deviceId: string): Promise<DeviceShadow> => {
    if (mock) { const latest = await mockApi.latest(deviceId); return { light: latest.light_state, fan: latest.fan_state }; }
    const shadow = await request<DeviceShadow & { reported_state?: DeviceShadow }>(api.get(`/devices/${deviceId}/shadow`));
    return { ...shadow, ...shadow.reported_state };
  },
  automationRules: (roomId: string) => mock ? Promise.resolve([]) : list(api.get(`/rooms/${roomId}/automation-rules`)),
  saveAutomationRule: (roomId: string, payload: Record<string, unknown>, id?: string) => mock ? Promise.resolve(payload) : id ? request(api.patch(`/automation-rules/${id}`, payload)) : request(api.post(`/rooms/${roomId}/automation-rules`, payload)),
  controlMode: (deviceId: string, control_mode: 'AUTO' | 'MANUAL') => mock ? Promise.resolve({ control_mode }) : request(api.put(`/devices/${deviceId}/control-mode`, { control_mode, reason: 'Cập nhật từ Dashboard' })),
  anomalies: () => mock ? Promise.resolve([]) : list(api.get('/anomalies')),
  monitoringSnapshot: () => mock ? Promise.resolve({}) : request(api.get('/monitoring/snapshot')),
  monitoringLogs: (params?: Record<string, string>) => mock ? Promise.resolve([]) : list(api.get('/monitoring/logs', { params })),
  otaFirmware: () => mock ? Promise.resolve([]) : list(api.get('/ota/firmware')),
  otaJobs: () => mock ? Promise.resolve([]) : list(api.get('/ota/jobs')),
  registerDevice: (payload: Partial<Device> & { device_name: string }) => mock ? mockApi.registerDevice(payload) : request<Device>(api.post('/devices', payload)).then(normalizeDevice),
  updateDevice: (id: string, payload: Partial<Device>) => mock ? Promise.resolve(payload) : request<Device>(api.patch(`/devices/${id}`, payload)).then(normalizeDevice),
  lifecycle: (id: string, action: DeviceAction, reason: string, confirmed = false) => mock ? mockApi.lifecycle(id, action, reason) : request<Device>(api.post(`/devices/${id}/${action}`, { reason, confirmed })).then(normalizeDevice),
  provision: (id: string, reason: string, confirmed = false) => mock ? mockApi.provision(id) : request<unknown>(api.post(`/devices/${id}/provision`, { reason, confirmed })),
  activate: (id: string, reason: string) => mock ? Promise.resolve({}) : request<unknown>(api.post(`/devices/${id}/activate`, { reason })),
  rotateCredentials: (id: string, reason: string) => mock ? mockApi.provision(id) : request<unknown>(api.post(`/devices/${id}/rotate-credentials`, { reason })),
  revoke: (id: string, reason: string, confirmed: boolean) => mock ? Promise.resolve({}) : request<unknown>(api.post(`/devices/${id}/revoke`, { reason, confirmed })),
  lifecycleEvents: (id: string) => mock ? mockApi.lifecycleEvents(id) : list(api.get(`/devices/${id}/lifecycle-events`)),
  alerts: (params?: { room_id?: string; status?: string; severity?: string; alert_type?: string }) => mock ? mockApi.alerts() : list<Alert>(api.get('/alerts', { params })).then((items) => items.map(normalizeAlert)),
  alert: (id: string) => request<Alert>(api.get(`/alerts/${id}`)).then(normalizeAlert),
  acknowledgeAlert: (id: string) => request<Alert>(api.post(`/alerts/${id}/acknowledge`, {})).then(normalizeAlert),
  resolveAlert: (id: string, reason: string) => request<Alert>(api.post(`/alerts/${id}/resolve`, { reason })).then(normalizeAlert),
  commands: (deviceId: string) => mock ? mockApi.commands(deviceId) : list<Command>(api.get(`/devices/${deviceId}/commands`, { params: { page: 1, page_size: 20 } })).then((items) => items.map(normalizeCommand)),
  command: async (deviceId: string, payload: { desired_state: { light?: 'ON' | 'OFF'; fan?: 'ON' | 'OFF' } }, key: string) => { if (mock) return mockApi.command(deviceId, payload); const result = await request<{ command: Command; cached: boolean; shadow: unknown }>(api.post(`/devices/${deviceId}/commands`, payload, { headers: { 'Idempotency-Key': key } })); return { ...normalizeCommand(result.command), shadow: result.shadow, cached: result.cached }; },
  users: () => mock ? mockApi.users() : list<User>(api.get('/users')).then(items => items.map(normalizeUser)),
  userPage: async (params: UserListQuery): Promise<UserPage> => {
    if (mock) return mockApi.userPage(params);
    const response = await api.get<ApiResponse<User[]>>('/users', { params });
    return { items: response.data.data.map(normalizeUser), total: response.data.meta?.total ?? response.data.data.length };
  },
  createUser: (input: CreateUserInput) => mock ? mockApi.createUser(input) : request<User>(api.post('/users', input)).then(normalizeUser),
  updateUser: (id: string, input: UpdateUserInput) => mock ? mockApi.updateUser(id, input) : request<User>(api.patch(`/users/${id}`, input)).then(normalizeUser),
  resetPassword: (id: string, new_password: string) => mock ? mockApi.resetPassword(id, new_password) : request(api.post(`/users/${id}/reset-password`, { new_password })),
  audit: (params?: Record<string, string>) => mock ? mockApi.audit() : list<unknown>(api.get('/audit-logs', { params })),
};
export default api;
