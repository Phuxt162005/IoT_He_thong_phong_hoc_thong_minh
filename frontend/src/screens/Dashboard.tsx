import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { commandText, dateText, read } from "../lib/resources";
import type {
  AlertRecord,
  CommandRecord,
  ShadowRecord,
  TelemetryRecord,
} from "../lib/resource-types";
import { useApi, useDevices, usePage, useRooms } from "../hooks/useApi";
import { useClock } from "../hooks/useClock";
import { Card, Empty, Loading, StatusBadge } from "../components/ui";
import { Choice, ErrorBox, Title } from "../components/workspace-ui";
type Snapshot = {
  rooms_count: number;
  device_counts: {
    lifecycle_status: string;
    connection_status: string;
    count: number;
  }[];
  unresolved_alert_counts: { severity: string; count: number }[];
  latest_telemetry: TelemetryRecord[];
  generated_at: string;
};
export function DashboardPage() {
  const rooms = useRooms();
  const [selected, setSelected] = useState("");
  const room =
    rooms.data?.find((item) => item.room_id === selected)?.room_id ||
    rooms.data?.[0]?.room_id ||
    "";
  const devices = useDevices(room || undefined);
  const query = useApi<Snapshot>(
    "dashboard",
    "/dashboard",
    { room_id: room },
    Boolean(room),
  );
  const sample = query.data?.latest_telemetry[0];
  const now = useClock(Boolean(sample?.fresh_until));
  const serverNow =
    now +
    (query.data
      ? Date.parse(query.data.generated_at) - query.dataUpdatedAt
      : 0);
  const sampleStale =
    sample?.stale ||
    Boolean(sample?.fresh_until && serverNow > Date.parse(sample.fresh_until));
  const controls = devices.data?.filter(
    (device) =>
      device.device_type === "CONTROL_NODE" && device.room_id === room,
  );
  const control =
    controls?.find((device) => device.lifecycle_status === "ACTIVE") ||
    controls?.[0];
  const shadow = useApi<ShadowRecord>(
    "shadow",
    `/devices/${control?.device_id}/shadow`,
    {},
    Boolean(control),
  );
  const commands = usePage<CommandRecord>(
    "commands",
    `/devices/${control?.device_id}/commands`,
    { page_size: 5 },
    Boolean(control),
  );
  const alerts = usePage<AlertRecord>(
    "alerts",
    "/alerts",
    { room_id: room, status: "OPEN", page_size: 5 },
    Boolean(room),
  );
  const chart = useQuery({
    queryKey: ["dashboard-chart", room],
    enabled: Boolean(room),
    queryFn: ({ signal }) =>
      read<Record<string, unknown>[]>(
        `/rooms/${room}/telemetry/stats`,
        {
          from: new Date(Date.now() - 86400000).toISOString(),
          to: new Date().toISOString(),
          bucket: "hour",
        },
        signal,
      ),
    retry: false,
    staleTime: 30000,
  });
  return (
    <>
      <Title
        action={
          <Choice
            label="Phòng học"
            value={room}
            empty="Chọn phòng"
            options={
              rooms.data?.map((room) => ({
                value: room.room_id,
                label: room.room_name,
              })) || []
            }
            onChange={setSelected}
          />
        }
      >
        Tổng quan
      </Title>
      {rooms.isLoading ? (
        <Loading />
      ) : rooms.error ? (
        <ErrorBox error={rooms.error} retry={() => void rooms.refetch()} />
      ) : !room ? (
        <Empty text="Chưa được gán phòng hoặc chưa có phòng học." />
      ) : (
        <>
          {query.error && (
            <ErrorBox error={query.error} retry={() => void query.refetch()} />
          )}
          {!sample && !query.isLoading && (
            <p className="notice">
              Phòng chưa có số đo. Trạng thái thiết bị và các chức năng khác vẫn
              hiển thị bên dưới.
            </p>
          )}
          {sampleStale && sample && (
            <p className="form-error">
              Dữ liệu cảm biến đã cũ · lần đo cuối{" "}
              {dateText(sample.recorded_at)}.
            </p>
          )}
          <div className="metric-grid">
            {[
              ["Nhiệt độ", sample?.temperature, "°C"],
              ["Độ ẩm", sample?.humidity, "%"],
              ["Ánh sáng", sample?.lux, "lux"],
              [
                "Hiện diện",
                sample?.occupancy == null
                  ? "Chưa rõ"
                  : sample.occupancy
                    ? "Có người"
                    : "Không có người",
                "",
              ],
            ].map(([label, value, unit]) => (
              <Card key={String(label)}>
                <p className="muted">{label}</p>
                <div className="metric">
                  {value ?? "—"}
                  <small>{unit}</small>
                </div>
                <p className="muted small">
                  {sample ? dateText(sample.recorded_at) : "Chưa có dữ liệu"}
                </p>
              </Card>
            ))}
          </div>
          <div className="two-col">
            <Card>
              <h3>Nhiệt độ trung bình theo giờ · 24 giờ gần nhất</h3>
              {chart.error ? (
                <ErrorBox
                  error={chart.error}
                  retry={() => void chart.refetch()}
                />
              ) : chart.data?.length ? (
                <div className="chart">
                  <ResponsiveContainer>
                    <AreaChart
                      data={chart.data.map((row) => ({
                        ...row,
                        time: dateText(String(row.bucket_at)),
                        temperature: Number(row.temperature_avg),
                      }))}
                    >
                      <XAxis dataKey="time" hide />
                      <YAxis />
                      <Tooltip />
                      <Area
                        dataKey="temperature"
                        name="Nhiệt độ (°C)"
                        stroke="#10b981"
                        fill="#10b98122"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Empty />
              )}
              <Link to="/telemetry">Xem lịch sử và xuất CSV →</Link>
            </Card>
            <Card>
              <h3>Trạng thái thiết bị</h3>
              {devices.error ? (
                <ErrorBox error={devices.error} />
              ) : (
                devices.data
                  ?.filter((device) => device.room_id === room)
                  .map((device) => (
                    <div className="list-row" key={device.device_id}>
                      <Link to={`/devices/${device.device_id}`}>
                        {device.device_name || device.device_code}
                      </Link>
                      <StatusBadge status={device.connection_status} />
                    </div>
                  ))
              )}
              {shadow.error && <ErrorBox error={shadow.error} />}
              <div className="state-row">
                Đèn{" "}
                <StatusBadge
                  status={shadow.data?.reported_state?.light || "UNKNOWN"}
                />{" "}
                Quạt{" "}
                <StatusBadge
                  status={shadow.data?.reported_state?.fan || "UNKNOWN"}
                />
              </div>
            </Card>
          </div>
          <div className="two-col">
            <Card>
              <h3>Cảnh báo đang mở ({alerts.data?.total ?? 0})</h3>
              {alerts.error ? (
                <ErrorBox error={alerts.error} />
              ) : alerts.data?.items.length ? (
                alerts.data.items.map((alert) => (
                  <div className="list-row" key={alert.alert_id}>
                    <span>{alert.message || alert.alert_type}</span>
                    <StatusBadge status={alert.severity} />
                  </div>
                ))
              ) : (
                <Empty text="Không có cảnh báo mở." />
              )}
              <Link to="/alerts">Xem tất cả cảnh báo →</Link>
            </Card>
            <Card>
              <h3>Điều khiển gần đây</h3>
              {commands.error ? (
                <ErrorBox error={commands.error} />
              ) : commands.data?.items.length ? (
                commands.data.items.map((command) => (
                  <div className="list-row" key={command.command_id}>
                    <span>
                      {commandText(command)}
                      <small>{dateText(command.created_at)}</small>
                    </span>
                    <StatusBadge status={command.status} />
                  </div>
                ))
              ) : (
                <Empty text="Chưa có lệnh." />
              )}
              <Link to="/control">Xem lịch sử điều khiển →</Link>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
