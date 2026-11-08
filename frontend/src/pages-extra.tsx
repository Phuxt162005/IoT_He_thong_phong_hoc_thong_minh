import { useEffect, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { apiService } from './lib/api';
import { useResource as useData } from './hooks/useResource';
import { useAuthStore } from './store/auth';
import { Card, Empty, ErrorState, Loading, StatusBadge } from './components/ui';
import { PageTitle } from './pages';
import type { Alert, Device, Room } from './types';

function TableHead({ columns }: { columns: string[] }) { return <div className="table-head">{columns.map((column) => <span key={column}>{column}</span>)}</div>; }

export function AlertsLive() {
  const canAct = useAuthStore(state => ['ADMIN', 'OPERATOR'].includes(state.user?.role || ''));
  const [filter, setFilter] = useState<{ status?: string; severity?: string }>({});
  const { data, loading, error, reload } = useData(() => apiService.alerts(filter), [filter.status, filter.severity]);
  const act = async (alert: Alert, action: 'acknowledge' | 'resolve') => { if (action === 'acknowledge') await apiService.acknowledgeAlert(alert.id); else await apiService.resolveAlert(alert.id, 'Đã xử lý trên Dashboard'); reload(); };
  return <><PageTitle title="Cảnh báo" action={<div className="filters"><select value={filter.status || ''} onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })}><option value="">Tất cả trạng thái</option><option>OPEN</option><option>ACKNOWLEDGED</option><option>RESOLVED</option></select><select value={filter.severity || ''} onChange={(e) => setFilter({ ...filter, severity: e.target.value || undefined })}><option value="">Tất cả mức độ</option><option>WARNING</option><option>CRITICAL</option></select></div>} />{loading ? <Loading /> : error ? <ErrorState retry={reload} /> : data?.length ? <Card><TableHead columns={['Loại', 'Mức độ', 'Phòng', 'Giá trị', 'Trạng thái', 'Thao tác']} />{data.map((alert) => <div className="table-row" key={alert.id}><strong>{alert.alert_type}</strong><StatusBadge status={alert.severity} /><span>{alert.room_name || alert.room_id || '—'}</span><span>{alert.value ?? '—'}</span><StatusBadge status={alert.status} /><span className="row-actions">{canAct && alert.status === 'OPEN' && <button className="secondary" onClick={() => act(alert, 'acknowledge')}>Xác nhận</button>}{canAct && alert.status !== 'RESOLVED' && <button className="secondary" onClick={() => act(alert, 'resolve')}>Đóng</button>}</span></div>)}</Card> : <Empty />}</>;
}

export function TelemetryLive() {
  const { data: rooms } = useData(apiService.rooms);
  const [roomId, setRoomId] = useState('');
  const [metric, setMetric] = useState<'temperature' | 'humidity' | 'lux'>('temperature');
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() }));
  const { data, loading, error, reload } = useData(() => roomId ? apiService.telemetry(roomId, range) : Promise.resolve([]), [roomId, range.from, range.to]);
  const rows = (data || []) as Array<Record<string, unknown>>;
  const chart = rows.map((row) => ({ time: String(row.recorded_at || '').slice(11, 16), value: Number(row[metric] ?? 0) }));
  return <><PageTitle title="Telemetry" action={<div className="filters"><select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">Chọn phòng</option>{rooms?.map((room) => <option key={room.id} value={room.id}>{room.room_name}</option>)}</select><select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}><option value="temperature">Nhiệt độ</option><option value="humidity">Độ ẩm</option><option value="lux">Ánh sáng</option></select><button className="primary" onClick={reload}>Áp dụng</button></div>} />{!roomId ? <Card><Empty text="Chọn phòng để tải telemetry từ backend" /></Card> : loading ? <Loading /> : error ? <ErrorState retry={reload} /> : <><Card><h3>Lịch sử dữ liệu thật</h3>{chart.length ? <div className="chart large"><ResponsiveContainer><AreaChart data={chart}><XAxis dataKey="time" /><YAxis /><Tooltip /><Area dataKey="value" stroke="#10b981" fill="#10b98122" /></AreaChart></ResponsiveContainer></div> : <Empty />}</Card><Card><TableHead columns={['Thời gian', 'Giá trị', 'Nhiệt độ', 'Độ ẩm', 'Lux']} />{rows.map((row, index) => <div className="table-row" key={`${String(row.data_id)}-${index}`}><span>{String(row.recorded_at || '—')}</span><strong>{String(row[metric] ?? '—')}</strong><span>{String(row.temperature ?? '—')}</span><span>{String(row.humidity ?? '—')}</span><span>{String(row.lux ?? '—')}</span></div>)}</Card></>}</>;
}

export function AuditLive() {
  const [query, setQuery] = useState<Record<string, string>>({});
  const { data, loading, error, reload } = useData(() => apiService.audit(query));
  return <><PageTitle title="Audit logs" action={<div className="filters"><input placeholder="Action" value={query.action || ''} onChange={(e) => setQuery({ ...query, action: e.target.value })} /><select value={query.result || ''} onChange={(e) => setQuery({ ...query, result: e.target.value })}><option value="">Tất cả kết quả</option><option>SUCCESS</option><option>FAILURE</option><option>DENIED</option></select><button className="primary" onClick={reload}>Lọc</button></div>} />{loading ? <Loading /> : error ? <ErrorState retry={reload} /> : data?.length ? <Card><TableHead columns={['Thời gian', 'Actor', 'Action', 'Đối tượng', 'Kết quả', 'Request ID']} />{data.map((item) => { const row = item as Record<string, unknown>; return <div className="table-row" key={String(row.log_id || row.id)}><span>{String(row.created_at || '—')}</span><span>{String(row.actor_type || '—')}</span><strong>{String(row.action || '—')}</strong><span>{String(row.target_type || '—')}</span><StatusBadge status={String(row.result || 'UNKNOWN')} /><span>{String(row.request_id || '—')}</span></div>; })}</Card> : <Empty />}</>;
}

export function DevicesLive() {
  const isAdmin = useAuthStore(state => state.user?.role === 'ADMIN');
  const { data, loading, error, reload } = useData(apiService.devices);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ device_code: '', device_name: '', device_type: 'SENSOR_NODE', room_id: '' });
  const submit = async (event: React.FormEvent) => { event.preventDefault(); await apiService.registerDevice(form as Partial<Device> & { device_name: string }); setShowForm(false); setForm({ device_code: '', device_name: '', device_type: 'SENSOR_NODE', room_id: '' }); reload(); };
  return <><PageTitle title="Thiết bị" action={isAdmin ? <button className="primary" onClick={() => setShowForm(!showForm)}>+ Đăng ký thiết bị</button> : undefined} />{isAdmin && showForm && <Card><form className="filters" onSubmit={submit}><input required pattern="[A-Za-z0-9_-]+" placeholder="device_code" value={form.device_code} onChange={(e) => setForm({ ...form, device_code: e.target.value })} /><input required placeholder="Tên thiết bị" value={form.device_name} onChange={(e) => setForm({ ...form, device_name: e.target.value })} /><select value={form.device_type} onChange={(e) => setForm({ ...form, device_type: e.target.value })}><option>SENSOR_NODE</option><option>CONTROL_NODE</option></select><input placeholder="room_id" value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })} /><button className="primary">Lưu</button></form></Card>}{loading ? <Loading /> : error ? <ErrorState retry={reload} /> : data?.length ? <Card><TableHead columns={['Thiết bị', 'Loại', 'Phòng', 'Vòng đời', 'Kết nối']} />{data.map((device) => <div className="table-row" key={device.id}><Link to={`/devices/${device.id}`}><strong>{device.device_code}</strong></Link><span>{device.device_type}</span><span>{device.room_name || device.room_id || '—'}</span><StatusBadge status={device.lifecycle_status} /><StatusBadge status={device.connection_status} /></div>)}</Card> : <Empty />}</>;
}

export function RoomsLive() {
  const isAdmin = useAuthStore(state => state.user?.role === 'ADMIN');
  const { data, loading, error, reload } = useData(apiService.rooms);
  const [form, setForm] = useState({ room_code: '', room_name: '' });
  const [showForm, setShowForm] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); await apiService.createRoom(form); setForm({ room_code: '', room_name: '' }); setShowForm(false); reload(); };
  return <><PageTitle title="Phòng học" action={isAdmin ? <button className="primary" onClick={() => setShowForm(!showForm)}>+ Thêm phòng</button> : undefined} />{isAdmin && showForm && <Card><form className="filters" onSubmit={submit}><input required placeholder="Mã phòng" value={form.room_code} onChange={(e) => setForm({ ...form, room_code: e.target.value })} /><input required placeholder="Tên phòng" value={form.room_name} onChange={(e) => setForm({ ...form, room_name: e.target.value })} /><button className="primary">Lưu</button></form></Card>}{loading ? <Loading /> : error ? <ErrorState retry={reload} /> : data?.length ? <Card><TableHead columns={['Mã phòng', 'Tên phòng', 'Trạng thái', 'Thiết bị']} />{data.map((room) => <div className="table-row" key={room.id}><Link to={`/rooms/${room.id}`}><strong>{room.room_code}</strong></Link><span>{room.room_name}</span><StatusBadge status={room.status} /><span>{room.device_count ?? '—'}</span></div>)}</Card> : <Empty />}</>;
}

export function AutomationLive() {
  const { data: rooms } = useData(apiService.rooms);
  const [roomId, setRoomId] = useState('');
  const { data, loading, error, reload } = useData(() => roomId ? apiService.automationRules(roomId) : Promise.resolve([]), [roomId]);
  return <><PageTitle title="Tự động hóa" action={<select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">Chọn phòng</option>{rooms?.map((room) => <option key={room.id} value={room.id}>{room.room_name}</option>)}</select>} />{!roomId ? <Card><Empty text="Chọn phòng để tải automation rules" /></Card> : loading ? <Loading /> : error ? <ErrorState retry={reload} /> : <Card>{data?.length ? data.map((rule) => <div className="list-row" key={String((rule as { rule_id?: string }).rule_id)}><span>{String((rule as { name?: string }).name || 'Rule')}</span><StatusBadge status={(rule as { is_enabled?: boolean }).is_enabled ? 'ACTIVE' : 'DISABLED'} /></div>) : <Empty text="Phòng chưa có automation rule" />}</Card>}</>;
}

export function AnomaliesLive() { const { data, loading, error, reload } = useData(apiService.anomalies); return <><PageTitle title="Phát hiện bất thường" />{loading ? <Loading /> : error ? <ErrorState retry={reload} /> : data?.length ? <Card><TableHead columns={['Thời gian', 'Thiết bị', 'Metric', 'Giá trị']} />{data.map((item, index) => <div className="table-row" key={index}><span>{String((item as { created_at?: string }).created_at || '—')}</span><span>{String((item as { device_id?: string }).device_id || '—')}</span><span>{String((item as { metric?: string }).metric || '—')}</span><strong>{String((item as { value?: number }).value || '—')}</strong></div>)}</Card> : <Empty text="Chưa phát hiện bất thường" />}</>; }

export function MonitoringLive() { const { data: snapshot, loading } = useData(apiService.monitoringSnapshot); return <><PageTitle title="Giám sát hệ thống" />{loading ? <Loading /> : <Card><pre className="json-panel">{JSON.stringify(snapshot, null, 2)}</pre></Card>}</>; }

export function OtaLive() { const { data: firmware, loading } = useData(apiService.otaFirmware); const { data: jobs } = useData(apiService.otaJobs); return <><PageTitle title="OTA firmware" />{loading ? <Loading /> : <><Card><h3>Firmware</h3>{firmware?.length ? firmware.map((item, index) => <div className="list-row" key={index}><span>{String((item as { version?: string }).version || '—')}</span><StatusBadge status={String((item as { status?: string }).status || 'UNKNOWN')} /></div>) : <Empty text="Chưa có firmware" />}</Card><Card><h3>OTA jobs</h3>{jobs?.length ? jobs.map((item, index) => <div className="list-row" key={index}><span>{String((item as { device_id?: string }).device_id || '—')}</span><StatusBadge status={String((item as { status?: string }).status || 'UNKNOWN')} /></div>) : <Empty text="Chưa có OTA job" />}</Card></>}</>; }
