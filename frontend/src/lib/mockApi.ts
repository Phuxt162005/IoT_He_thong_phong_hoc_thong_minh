import { alerts, chartData, commands, devices, latest, lifecycleEvents, rooms, users } from '../mocks/data';
import type { Command, CreateUserInput, Device, DeviceAction, LatestTelemetry, RegisterInput, Room, UpdateUserInput, User, UserListQuery } from '../types';
import { useAuthStore } from '../store/auth';
const wait = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 280));
const passwords = new Map(users.map(user => [user.id, 'Smart@123456']));
function requireAdmin() { if (useAuthStore.getState().user?.role !== 'ADMIN') throw new Error('Không có quyền quản lý tài khoản.'); }
function addUser(input: RegisterInput, role: User['role']): User {
  if (users.some(user => user.username === input.username)) throw new Error('Tên đăng nhập đã được sử dụng');
  const user: User = { id: crypto.randomUUID(), username: input.username, display_name: input.display_name, role, status: 'ACTIVE' };
  users.push(user);
  passwords.set(user.id, input.password);
  return user;
}
export const mockApi = {
  login: async (username: string, password: string) => { const user = users.find((x) => x.username === username); if (!user || user.status !== 'ACTIVE' || password !== passwords.get(user.id)) throw new Error('Tên đăng nhập hoặc mật khẩu không đúng.'); return wait({ access_token: `mock-token-${user.id}`, user: { ...user } }); },
  register: (input: RegisterInput) => wait(addUser(input, 'VIEWER')),
  me: () => wait(useAuthStore.getState().user!),
  changePassword: async (current: string, next: string) => { const id = useAuthStore.getState().user?.id; if (!id || passwords.get(id) !== current) throw new Error('Mật khẩu hiện tại không đúng.'); passwords.set(id, next); await wait(undefined); },
  userPage: (params: UserListQuery) => { requireAdmin(); const filtered = users.filter(user => (!params.role || user.role === params.role) && (!params.status || user.status === params.status)); return wait({ items: filtered.slice((params.page - 1) * params.page_size, params.page * params.page_size), total: filtered.length }); },
  createUser: (input: CreateUserInput) => { requireAdmin(); return wait(addUser(input, input.role)); },
  updateUser: (id: string, input: UpdateUserInput) => { requireAdmin(); const user = users.find(item => item.id === id); if (!user || user.role === 'ADMIN') throw new Error('Không thể sửa tài khoản này.'); Object.assign(user, input); return wait({ ...user }); },
  resetPassword: async (id: string, password: string) => { requireAdmin(); const user = users.find(item => item.id === id); if (!user || user.role === 'ADMIN') throw new Error('Chỉ đặt lại mật khẩu cho Operator hoặc Viewer.'); passwords.set(id, password); await wait(undefined); },
  rooms: () => wait(rooms),
  devices: () => wait(devices),
  latest: (_roomId: string) => wait(latest),
  device: (id: string) => wait(devices.find((device) => device.id === id)),
  registerDevice: (payload: Partial<Device>) => wait({ ...devices[0], ...payload, id: `d-${Date.now()}`, lifecycle_status: 'REGISTERED', connection_status: 'UNKNOWN' } as Device),
  lifecycle: (id: string, action: DeviceAction, reason: string) => wait({ ...devices.find((device) => device.id === id), lifecycle_status: action === 'maintenance' ? 'MAINTENANCE' : action === 'decommission' ? 'DECOMMISSIONED' : 'ACTIVE', maintenance_reason: reason } as Device),
  provision: (id: string) => wait({ credentials: { username: devices.find((device) => device.id === id)?.device_code, password: `mock-secret-${Date.now()}`, mqtt_url: 'mqtt://localhost:1884' } }),
  lifecycleEvents: (_id: string) => wait(lifecycleEvents),
  alerts: () => wait(alerts),
  commands: (_deviceId: string) => wait(commands),
  command: (_deviceId: string, payload: { desired_state: { light?: 'ON' | 'OFF'; fan?: 'ON' | 'OFF' } }) => wait<Command>({ id: `cmd-${Date.now()}`, actuator_type: payload.desired_state.light ? 'LIGHT' : 'FAN', target_state: (payload.desired_state.light || payload.desired_state.fan) as Command['target_state'], status: 'PENDING', created_at: new Date().toISOString() }),
  users: () => wait<User[]>(users),
  audit: () => wait([{ id: 'log-1', created_at: new Date().toISOString(), actor_type: 'USER', action: 'LOGIN', target_type: 'SESSION', result: 'SUCCESS', ip: '127.0.0.1', request_id: 'req-demo-01', details: {} }]),
  chart: () => wait(chartData),
};
export type MockApi = typeof mockApi;
