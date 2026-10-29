import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/layout';
import { useAuthStore } from './store/auth';
import { Login, Dashboard, Rooms, RoomDetail, Devices, Alerts, Users, Detail, Telemetry, Control, Automation, Audit } from './pages';
import './styles.css';
function Guard({ roles }: { roles?: string[] }) { const { user } = useAuthStore(); if (!user) return <Navigate to="/login" replace />; if (roles && !roles.includes(user.role)) return <Navigate to="/403" replace />; return <Outlet />; }
function Forbidden() { return <div className="empty-page"><h2>403</h2><p>Bạn không có quyền truy cập trang này.</p><a href="/dashboard">Về tổng quan</a></div>; }
const queryClient = new QueryClient();
function App() { return <QueryClientProvider client={queryClient}><Routes><Route path="/login" element={<Login />} /><Route path="/403" element={<Forbidden />} /><Route element={<Guard />}><Route element={<Layout />}><Route path="/dashboard" element={<Dashboard />} /><Route path="/rooms" element={<Rooms />} /><Route path="/rooms/:id" element={<RoomDetail />} /><Route path="/devices" element={<Devices />} /><Route path="/devices/:id" element={<Detail />} /><Route path="/telemetry" element={<Telemetry />} /><Route path="/alerts" element={<Alerts />} /><Route path="/control" element={<Guard roles={['ADMIN', 'OPERATOR']} />}><Route index element={<Control />} /><Route path="automation" element={<Automation />} /></Route><Route path="/users" element={<Guard roles={['ADMIN']} />}><Route index element={<Users />} /></Route><Route path="/audit-logs" element={<Guard roles={['ADMIN']} />}><Route index element={<Audit />} /></Route></Route></Route><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></QueryClientProvider>; }
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>);
