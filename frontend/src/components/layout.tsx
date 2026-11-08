import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Activity, Bell, BookOpen, Boxes, ChevronLeft, Gauge, LogOut, Menu, Moon, Settings, Shield, SlidersHorizontal, Sun, Users } from 'lucide-react';
import { useAuthStore } from '../store/auth';
import { useWebSocket } from '../hooks/useWebSocket';
import { apiService } from '../lib/api';

const nav = [
  { to: '/dashboard', label: 'Tổng quan', icon: Gauge },
  { to: '/rooms', label: 'Phòng học', icon: BookOpen },
  { to: '/devices', label: 'Thiết bị', icon: Boxes },
  { to: '/telemetry', label: 'Telemetry', icon: Activity },
  { to: '/alerts', label: 'Cảnh báo', icon: Bell },
  { to: '/anomalies', label: 'Phát hiện bất thường', icon: Activity },
  { to: '/control', label: 'Điều khiển', icon: SlidersHorizontal, roles: ['ADMIN', 'OPERATOR'] },
  { to: '/control/automation', label: 'Tự động hóa', icon: Settings, roles: ['ADMIN'] },
  { to: '/users', label: 'Người dùng', icon: Users, roles: ['ADMIN'] },
  { to: '/audit-logs', label: 'Audit logs', icon: Shield, roles: ['ADMIN'] },
  { to: '/monitoring', label: 'Giám sát hệ thống', icon: Activity, roles: ['ADMIN'] },
  { to: '/ota', label: 'OTA firmware', icon: Boxes, roles: ['ADMIN'] },
];

export function Layout() {
  const queries = useQueryClient();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const socketStatus = useWebSocket();
  const allowed = nav.filter(item => !item.roles || (user && item.roles.includes(user.role)));
  return <div className={dark ? 'app dark' : 'app'}>
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="brand"><div className="brand-mark">SC</div>{!collapsed && <span>Smart Classroom</span>}</div>
      <nav>{allowed.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={18} />{!collapsed && <span>{label}</span>}</NavLink>)}</nav>
      <button className="collapse" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <Menu size={18} /> : <ChevronLeft size={18} />}</button>
    </aside>
    <div className="main"><header className="topbar">
      <div><p className="eyebrow">HỆ THỐNG IOT</p><h1>Smart Classroom</h1></div>
      <div className="top-actions">
        <span className={`socket-status ${socketStatus}`}>● {socketStatus === 'connected' ? 'WebSocket đã kết nối' : socketStatus === 'reconnecting' ? 'Đang kết nối lại' : 'WebSocket ngắt kết nối'}</span>
        <button className="icon-btn" onClick={() => setDark(!dark)} aria-label="Đổi giao diện">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
        <button className="icon-btn alert-btn" onClick={() => navigate('/alerts')} aria-label="Cảnh báo"><Bell size={18} /><b>1</b></button>
        <div className="profile"><div className="avatar">{user?.display_name?.[0] || 'U'}</div><div><strong>{user?.display_name}</strong><small>{user?.role}</small></div>
          <Link className="password-link" to="/account">Đổi mật khẩu</Link>
          <button className="icon-btn" disabled={logoutBusy} aria-label="Đăng xuất" onClick={async () => {
            setLogoutBusy(true);
            try { await apiService.logout(); }
            catch { /* Vẫn kết thúc phiên cục bộ khi không kết nối được máy chủ. */ }
            finally { queries.clear(); logout(); navigate('/login', { replace: true }); }
          }}><LogOut size={16} /></button>
        </div>
      </div>
    </header><main className="content"><Outlet /></main></div>
  </div>;
}
