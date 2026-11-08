import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Layout } from './components/layout';
import { ErrorState, Loading } from './components/ui';
import { useAuthStore } from './store/auth';
import { apiService } from './lib/api';
import { Login, Register, ChangePassword, Dashboard, Rooms, RoomDetail, Devices, Alerts, Users, Detail, Telemetry, Control, Automation, Audit } from './pages';
import './styles.css';

function Guard({ roles }: { roles?: string[] }) {
  const { token, user, login } = useAuthStore();
  const session = useQuery({ queryKey: ['session', token], queryFn: apiService.me, enabled: Boolean(token && user), retry: false, staleTime: 60000 });
  useEffect(() => { if (token && session.data) login(token, session.data); }, [token, session.data, login]);
  if (!token || !user) return <Navigate to="/login" replace />;
  if (session.isLoading) return <Loading />;
  if (session.isError) return <ErrorState retry={() => { void session.refetch(); }} />;
  if (roles && (!session.data || !roles.includes(session.data.role))) return <Navigate to="/403" replace />;
  return <Outlet />;
}
function Forbidden() { return <div className="empty-page"><h2>403</h2><p>Bạn không có quyền truy cập trang này.</p><a href="/dashboard">Về tổng quan</a></div>; }
const queryClient = new QueryClient();
function App() {
  return <QueryClientProvider client={queryClient}><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/register" element={<Register />} />
    <Route path="/403" element={<Forbidden />} />
    <Route element={<Guard />}><Route element={<Layout />}>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/account" element={<ChangePassword />} />
      <Route path="/rooms" element={<Rooms />} />
      <Route path="/rooms/:id" element={<RoomDetail />} />
      <Route path="/devices" element={<Devices />} />
      <Route path="/devices/:id" element={<Detail />} />
      <Route path="/telemetry" element={<Telemetry />} />
      <Route path="/alerts" element={<Alerts />} />
      <Route path="/control" element={<Guard roles={['ADMIN', 'OPERATOR']} />}><Route index element={<Control />} /></Route>
      <Route element={<Guard roles={['ADMIN']} />}>
        <Route path="/control/automation" element={<Automation />} />
        <Route path="/users" element={<Users />} />
        <Route path="/audit-logs" element={<Audit />} />
      </Route>
    </Route></Route>
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </Routes></QueryClientProvider>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>);
