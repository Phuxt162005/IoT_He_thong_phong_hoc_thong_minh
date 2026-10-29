import { alerts, chartData, commands, devices, latest, lifecycleEvents, rooms, users } from '../mocks/data';
import type { Command, Device, DeviceAction, LatestTelemetry, Room, User } from '../types';
const wait = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 280));
export const mockApi = {
  login: async (username: string, password: string) => { const user = users.find((x) => x.username === username); if (!user || password !== 'Smart@123456') throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' }); return wait({ access_token: `mock-token-${user.id}`, user }); },
  me: () => wait(users[0]),
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
