import axios from 'axios';
import type { Alert, ApiResponse, Command, Device, DeviceAction, LatestTelemetry, Room, User } from '../types';
import { useAuthStore } from '../store/auth';
import { mockApi } from './mockApi';

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api/v1', timeout: 10000 });
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = ['Bearer', token].join(' ');
  return config;
});
api.interceptors.response.use((response) => response, (error) => {
  if (error.response?.status === 401) useAuthStore.getState().logout();
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
function normalizeDevice(device: Device & { device_id?: string; last_rssi_dbm?: number; last_free_heap_bytes?: number; last_uptime_seconds?: number; last_seen?: string; room_code?: string }): Device {
  return { ...device, id: device.id || device.device_id || '', wifi_rssi_dbm: device.wifi_rssi_dbm ?? device.last_rssi_dbm, free_heap_bytes: device.free_heap_bytes ?? device.last_free_heap_bytes, uptime_seconds: device.uptime_seconds ?? device.last_uptime_seconds, room_name: device.room_name || device.room_code };
}
async function normalizedDevices(promise: Promise<{ data: ApiResponse<Device[] | { items: Device[] }> }>) { return (await list<Device>(promise)).map(normalizeDevice); }
function normalizeRoom(room: Room & { room_id?: string }): Room { return { ...room, id: room.id || room.room_id || '' }; }
export const apiService = {
  login: (username: string, password: string) => mock ? mockApi.login(username, password) : request<LoginResponse>(api.post('/auth/login', { username, password })),
  me: () => mock ? mockApi.me() : request<User>(api.get('/auth/me')),
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
  users: () => mock ? mockApi.users() : list<User>(api.get('/users')),
  audit: () => mock ? mockApi.audit() : list<unknown>(api.get('/audit-logs')),
};
export default api;
