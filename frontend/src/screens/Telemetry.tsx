import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  dateText,
  exportTelemetry,
  localInput,
  page,
  read,
  timeRange,
} from "../lib/resources";
import type { TelemetryRecord } from "../lib/resource-types";
import { useDevices, useRooms } from "../hooks/useApi";
import { Card, Empty } from "../components/ui";
import {
  Choice,
  ErrorBox,
  Filters,
  Paged,
  Title,
  useAction,
} from "../components/workspace-ui";
export function TelemetryPage() {
  const rooms = useRooms();
  const [room, setRoom] = useState("");
  const devices = useDevices(room || undefined);
  const [device, setDevice] = useState("");
  const [metric, setMetric] = useState("temperature");
  const [live, setLive] = useState(true);
  const [hours, setHours] = useState(1);
  const [draft, setDraft] = useState({
    from: localInput(new Date(Date.now() - 3600000)),
    to: localInput(new Date(Date.now() + 1000)),
  });
  const [range, setRange] = useState(() => timeRange(draft.from, draft.to, 31));
  const [number, setNumber] = useState(1);
  const [stats, setStats] = useState(false);
  const [bucket, setBucket] = useState("hour");
  const action = useAction();
  const bounds = () =>
    live
      ? {
          from: new Date(Date.now() - hours * 3600000).toISOString(),
          to: new Date().toISOString(),
        }
      : range;
  const query = useQuery({
    queryKey: ["telemetry", room, device, live, hours, range, number],
    enabled: Boolean(room),
    queryFn: ({ signal }) =>
      page<TelemetryRecord>(
        `/rooms/${room}/telemetry`,
        { ...bounds(), device_id: device, page: number, page_size: 20 },
        signal,
      ),
    retry: false,
  });
  const statistics = useQuery({
    queryKey: ["telemetry-stats", room, device, live, hours, range, bucket],
    enabled: Boolean(room && stats),
    queryFn: ({ signal }) =>
      read<Record<string, unknown>[]>(
        `/rooms/${room}/telemetry/stats`,
        { ...bounds(), bucket },
        signal,
      ),
    retry: false,
  });
  const chart =
    (stats
      ? (statistics.data || []).map((row) => ({
          time: dateText(String(row.bucket_at)),
          value:
            metric === "occupancy"
              ? Number(row.occupancy_known_samples)
                ? (100 * Number(row.occupied_samples)) /
                  Number(row.occupancy_known_samples)
                : null
              : Number(row[metric + "_avg"]),
        }))
      : query.data?.items
          .slice()
          .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at))
          .map((row) => ({
            time: dateText(row.recorded_at),
            value:
              metric === "occupancy"
                ? row.occupancy == null
                  ? null
                  : Number(row.occupancy)
                : row[metric as "temperature" | "humidity" | "lux"],
          }))) || [];
  return (
    <>
      <Title>Telemetry</Title>
      <Filters>
        <Choice
          label="Phòng"
          empty="Chọn phòng"
          value={room}
          options={
            rooms.data?.map((row) => ({
              value: row.room_id,
              label: row.room_name,
            })) || []
          }
          onChange={(v) => {
            setRoom(v);
            setDevice("");
            setNumber(1);
          }}
        />
        <Choice
          label="Thiết bị"
          value={device}
          options={
            devices.data
              ?.filter(
                (row) =>
                  row.room_id === room && row.device_type === "SENSOR_NODE",
              )
              .map((row) => ({
                value: row.device_id,
                label: row.device_name,
              })) || []
          }
          onChange={(v) => {
            setDevice(v);
            setNumber(1);
          }}
        />
        <Choice
          label="Chỉ số"
          value={metric}
          empty="Chọn chỉ số"
          options={[
            ["temperature", "Nhiệt độ (°C)"],
            ["humidity", "Độ ẩm (%)"],
            ["lux", "Ánh sáng (lux)"],
            ["occupancy", stats ? "Tỷ lệ có người (%)" : "Hiện diện (0/1)"],
          ].map(([value, label]) => ({ value, label }))}
          onChange={(v) => setMetric(v || "temperature")}
        />
        <label>
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => {
              setLive(e.target.checked);
              setNumber(1);
            }}
          />{" "}
          Theo dõi thời gian hiện tại
        </label>
        {live ? (
          <label>
            Khoảng gần nhất
            <select
              value={hours}
              onChange={(e) => {
                setHours(Number(e.target.value));
                setNumber(1);
              }}
            >
              {[1, 6, 24].map((value) => (
                <option key={value} value={value}>
                  {value} giờ
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label>
              Từ
              <input
                type="datetime-local"
                step="1"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label>
              Đến
              <input
                type="datetime-local"
                step="1"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
          </>
        )}
        <button
          className="primary"
          disabled={!room || action.busy}
          onClick={() =>
            void action.run(async () => {
              if (!live) {
                const next = timeRange(draft.from, draft.to, 31);
                setRange(next);
                if (
                  next.from !== range.from ||
                  next.to !== range.to ||
                  number !== 1
                ) {
                  setNumber(1);
                  return;
                }
              }
              if (number !== 1) {
                setNumber(1);
                return;
              }
              setNumber(1);
              await query.refetch();
              if (stats) await statistics.refetch();
            }, "")
          }
        >
          Áp dụng / Cập nhật
        </button>
        <button
          className="secondary"
          disabled={!room || action.busy}
          onClick={() =>
            void action.run(async () => {
              const blob = await exportTelemetry(room, {
                ...bounds(),
                device_id: device,
              });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = "telemetry.csv";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }, "Đã xuất CSV.")
          }
        >
          Xuất CSV
        </button>
      </Filters>
      {rooms.error && <ErrorBox error={rooms.error} />}
      {action.error && <ErrorBox error={action.error} />}
      {action.message && <p className="notice">{action.message}</p>}
      {!room ? (
        <Empty text="Chọn phòng để xem dữ liệu." />
      ) : (
        <>
          <Card>
            <div className="filters">
              <label>
                <input
                  type="checkbox"
                  checked={stats}
                  onChange={(e) => setStats(e.target.checked)}
                />{" "}
                Thống kê toàn khoảng thời gian
              </label>
              {stats && (
                <label>
                  Nhóm theo
                  <select
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                  >
                    <option value="hour">Giờ</option>
                    <option value="day">Ngày</option>
                  </select>
                </label>
              )}
            </div>
            <p className="muted small">
              {stats
                ? "Biểu đồ thống kê toàn phòng (không lọc thiết bị)."
                : "Biểu đồ các mẫu trên trang đang xem."}{" "}
              Thời gian hiển thị theo múi giờ máy của bạn.
            </p>
            {stats && statistics.data && (
              <p className="muted small telemetry-summary">
                {statistics.data.reduce(
                  (sum, row) => sum + Number(row.sample_count || 0),
                  0,
                )}{" "}
                mẫu · {statistics.data.length} nhóm{" "}
                {bucket === "day" ? "ngày" : "giờ"}.
              </p>
            )}
            {statistics.error && stats ? (
              <ErrorBox error={statistics.error} />
            ) : chart.length ? (
              <div className="chart large">
                <ResponsiveContainer>
                  <AreaChart data={chart}>
                    <XAxis dataKey="time" />
                    <YAxis
                      domain={
                        metric === "occupancy"
                          ? [0, stats ? 100 : 1]
                          : ["auto", "auto"]
                      }
                    />
                    <Tooltip
                      formatter={(value: number) =>
                        metric === "occupancy" && stats
                          ? `${value.toFixed(1)}%`
                          : value
                      }
                    />
                    <Area
                      dataKey="value"
                      name={
                        metric === "occupancy"
                          ? stats
                            ? "Tỷ lệ có người (%)"
                            : "Hiện diện (0/1)"
                          : metric
                      }
                      stroke="#10b981"
                      fill="#10b98122"
                      connectNulls={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty />
            )}
          </Card>
          <p className="muted small">
            Khoảng dữ liệu: {dateText(query.data?.from)} →{" "}
            {dateText(query.data?.to)}
          </p>
          <Paged
            query={query}
            change={setNumber}
            rowKey={(row) => row.data_id}
            columns={[
              {
                label: "Thời gian đo",
                render: (row) => dateText(row.recorded_at),
              },
              {
                label: "Thiết bị",
                render: (row) =>
                  devices.data?.find(
                    (device) => device.device_id === row.device_id,
                  )?.device_name || row.device_id,
              },
              { label: "Nhiệt độ", render: (row) => row.temperature },
              { label: "Độ ẩm", render: (row) => row.humidity },
              { label: "Lux", render: (row) => row.lux },
              {
                label: "Hiện diện",
                render: (row) =>
                  row.occupancy == null
                    ? "Chưa rõ"
                    : row.occupancy
                      ? "Có người"
                      : "Không có người",
              },
              {
                label: "Ghi chú",
                render: (row) =>
                  [
                    row.clock_skew ? "Lệch đồng hồ" : "",
                    row.is_backfill ? "Đồng bộ bù" : "",
                  ]
                    .filter(Boolean)
                    .join(", ") || "—",
              },
            ]}
          />
        </>
      )}
    </>
  );
}
