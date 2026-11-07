import axios from 'axios';
import type { Alert, ApiResponse, Command, CreateUserInput, Device, DeviceAction, LatestTelemetry, RegisterInput, Room, UpdateUserInput, User, UserListQuery, UserPage } from '../types';
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
  device: (id: string) => mock ? mockApi.device(id) : request<Device>(api.get(`/devices/${id}`)).then(normalizeDevice),
  latest: async (roomId: string) => {
    if (mock) return mockApi.latest(roomId);
    const result = await request<Array<LatestTelemetry & { recorded_at?: string; stale?: boolean }>>(api.get(`/rooms/${roomId}/telemetry/latest`));
    const row = result[0];
    return row ? { temperature: row.temperature, humidity: row.humidity, lux: row.lux, occupancy: row.occupancy, updated_at: row.recorded_at } : {};
  },
  registerDevice: (payload: Partial<Device> & { device_name: string }) => mock ? mockApi.registerDevice(payload) : request<Device>(api.post('/devices', payload)).then(normalizeDevice),
  lifecycle: (id: string, action: DeviceAction, reason: string, confirmed = false) => mock ? mockApi.lifecycle(id, action, reason) : request<Device>(api.post(`/devices/${id}/${action}`, { reason, confirmed })).then(normalizeDevice),
  provision: (id: string, reason: string, confirmed = false) => mock ? mockApi.provision(id) : request<unknown>(api.post(`/devices/${id}/provision`, { reason, confirmed })),
  lifecycleEvents: (id: string) => mock ? mockApi.lifecycleEvents(id) : list(api.get(`/devices/${id}/lifecycle-events`)),
  alerts: () => mock ? mockApi.alerts() : list<Alert>(api.get('/alerts')),
  commands: (deviceId: string) => mock ? mockApi.commands(deviceId) : request<Command[]>(api.get(`/devices/${deviceId}/commands`)),
  command: (deviceId: string, payload: { desired_state: { light?: 'ON' | 'OFF'; fan?: 'ON' | 'OFF' } }, key: string) => mock ? mockApi.command(deviceId, payload) : request<Command>(api.post(`/devices/${deviceId}/commands`, payload, { headers: { 'Idempotency-Key': key } })),
  users: () => mock ? mockApi.users() : list<User>(api.get('/users')).then(items => items.map(normalizeUser)),
  userPage: async (params: UserListQuery): Promise<UserPage> => {
    if (mock) return mockApi.userPage(params);
    const response = await api.get<ApiResponse<User[]>>('/users', { params });
    return { items: response.data.data.map(normalizeUser), total: response.data.meta?.total ?? response.data.data.length };
  },
  createUser: (input: CreateUserInput) => mock ? mockApi.createUser(input) : request<User>(api.post('/users', input)).then(normalizeUser),
  updateUser: (id: string, input: UpdateUserInput) => mock ? mockApi.updateUser(id, input) : request<User>(api.patch(`/users/${id}`, input)).then(normalizeUser),
  resetPassword: (id: string, new_password: string) => mock ? mockApi.resetPassword(id, new_password) : request(api.post(`/users/${id}/reset-password`, { new_password })),
  audit: () => mock ? mockApi.audit() : list<unknown>(api.get('/audit-logs')),
};
export default api;
