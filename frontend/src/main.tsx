import React, { lazy, Suspense, useEffect } from "react";
import ReactDOM from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Layout } from "./components/layout";
import { ErrorState, Loading } from "./components/ui";
import { useAuthStore } from "./store/auth";
import { apiService } from "./lib/api";
import { Login, Register, ChangePassword } from "./auth-pages";
import { Users } from "./user-management";
const Dashboard = lazy(() =>
  import("./screens/Dashboard").then((m) => ({ default: m.DashboardPage })),
);
const Rooms = lazy(() =>
  import("./screens/Rooms").then((m) => ({ default: m.RoomsPage })),
);
const RoomDetail = lazy(() =>
  import("./screens/Rooms").then((m) => ({ default: m.RoomDetailPage })),
);
const Devices = lazy(() =>
  import("./screens/Devices").then((m) => ({ default: m.DevicesPage })),
);
const Detail = lazy(() =>
  import("./screens/Devices").then((m) => ({ default: m.DeviceDetailPage })),
);
const Telemetry = lazy(() =>
  import("./screens/Telemetry").then((m) => ({ default: m.TelemetryPage })),
);
const Alerts = lazy(() =>
  import("./screens/Alerts").then((m) => ({ default: m.AlertsPage })),
);
const Control = lazy(() =>
  import("./screens/Control").then((m) => ({ default: m.ControlPage })),
);
const Automation = lazy(() =>
  import("./screens/Automation").then((m) => ({ default: m.AutomationPage })),
);
const Audit = lazy(() =>
  import("./screens/Records").then((m) => ({ default: m.AuditPage })),
);
const Anomalies = lazy(() =>
  import("./screens/Records").then((m) => ({ default: m.AnomaliesPage })),
);
const Monitoring = lazy(() =>
  import("./screens/Monitoring").then((m) => ({ default: m.MonitoringPage })),
);
const Ota = lazy(() =>
  import("./screens/Ota").then((m) => ({ default: m.OtaPage })),
);
import "./styles.css";

function Guard({ roles }: { roles?: string[] }) {
  const { token, user, login } = useAuthStore();
  const session = useQuery({
    queryKey: ["session", token],
    queryFn: apiService.me,
    enabled: Boolean(token && user),
    retry: false,
    staleTime: 60000,
  });
  useEffect(() => {
    if (token && session.data) login(token, session.data);
  }, [token, session.data, login]);
  if (!token || !user) return <Navigate to="/login" replace />;
  if (session.isLoading) return <Loading />;
  if (session.isError)
    return (
      <ErrorState
        retry={() => {
          void session.refetch();
        }}
      />
    );
  if (roles && (!session.data || !roles.includes(session.data.role)))
    return <Navigate to="/403" replace />;
  return <Outlet />;
}
function Forbidden() {
  return (
    <div className="empty-page">
      <h2>403</h2>
      <p>Bạn không có quyền truy cập trang này.</p>
      <a href="/dashboard">Về tổng quan</a>
    </div>
  );
}
const queryClient = new QueryClient();
function App() {
  useEffect(
    () =>
      useAuthStore.subscribe((next, previous) => {
        if (next.token !== previous.token) queryClient.clear();
      }),
    [],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/403" element={<Forbidden />} />
          <Route element={<Guard />}>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/account" element={<ChangePassword />} />
              <Route path="/rooms" element={<Rooms />} />
              <Route path="/rooms/:id" element={<RoomDetail />} />
              <Route path="/devices" element={<Devices />} />
              <Route path="/devices/:id" element={<Detail />} />
              <Route path="/telemetry" element={<Telemetry />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/control/automation" element={<Automation />} />
              <Route path="/ota" element={<Ota />} />
              <Route path="/anomalies" element={<Anomalies />} />
              <Route path="/control" element={<Control />} />
              <Route element={<Guard roles={["ADMIN"]} />}>
                <Route path="/users" element={<Users />} />
                <Route path="/audit-logs" element={<Audit />} />
                <Route path="/monitoring" element={<Monitoring />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </QueryClientProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
