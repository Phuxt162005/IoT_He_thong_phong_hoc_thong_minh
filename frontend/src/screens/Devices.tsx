import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store/auth";
import { dateText, envelope, timeRange, write } from "../lib/resources";
import type {
  ConfigData,
  CredentialResult,
  DeviceRecord,
} from "../lib/resource-types";
import { useApi, usePage, useRooms } from "../hooks/useApi";
import { deviceBlockReason } from "../lib/device-readiness";
import { Card, Empty, Loading, StatusBadge } from "../components/ui";
import {
  Choice,
  DetailData,
  Editor,
  ErrorBox,
  Filters,
  Paged,
  Pager,
  Table,
  Title,
  useFilters,
} from "../components/workspace-ui";
import type { Field } from "../components/workspace-ui";
const lifecycle = [
  "REGISTERED",
  "PROVISIONED",
  "ACTIVE",
  "FAULT",
  "MAINTENANCE",
  "REVOKED",
  "DECOMMISSIONED",
].map((value) => ({ value, label: value }));
function DeviceEditor({
  device,
  close,
}: {
  device?: DeviceRecord;
  close: () => void;
}) {
  const rooms = useRooms();
  const fields: Field[] = [
    ...(!device
      ? [
          {
            name: "device_code",
            label: "Mã thiết bị",
            required: true,
            pattern: "[A-Za-z0-9_-]{1,40}",
            maxLength: 40,
          },
          {
            name: "device_type",
            label: "Loại node",
            type: "select" as const,
            required: true,
            options: ["SENSOR_NODE", "CONTROL_NODE"].map((value) => ({
              value,
              label: value,
            })),
          },
        ]
      : []),
    {
      name: "device_name",
      label: "Tên thiết bị",
      required: true,
      maxLength: 100,
    },
    ...(!device || device.lifecycle_status === "REGISTERED"
      ? [
          {
            name: "room_id",
            label: "Phòng (có thể để trống)",
            type: "select" as const,
            options:
              rooms.data
                ?.filter((room) => room.status === "ACTIVE")
                .map((room) => ({
                  value: room.room_id,
                  label: room.room_name,
                })) || [],
          },
        ]
      : []),
    { name: "hardware_version", label: "Phiên bản phần cứng", maxLength: 64 },
    { name: "firmware_version", label: "Phiên bản firmware", maxLength: 64 },
  ];
  return (
    <Editor
      title={device ? "Sửa thiết bị" : "Đăng ký thiết bị"}
      fields={fields}
      initial={
        device
          ? {
              device_name: device.device_name,
              room_id: device.room_id || "",
              hardware_version: device.hardware_version || "",
              firmware_version: device.firmware_version || "",
            }
          : { device_type: "SENSOR_NODE" }
      }
      close={close}
      save={(values) => {
        const payload: Record<string, unknown> = {
          device_name: values.device_name,
        };
        for (const key of ["hardware_version", "firmware_version"])
          if (values[key]) payload[key] = values[key];
        if (!device) {
          payload.device_code = values.device_code;
          payload.device_type = values.device_type;
          if (values.room_id) payload.room_id = values.room_id;
        } else if (device.lifecycle_status === "REGISTERED")
          payload.room_id = values.room_id || null;
        return write(
          device ? "PATCH" : "POST",
          device ? `/devices/${device.device_id}` : "/devices",
          payload,
        );
      }}
    >
      {rooms.error && <ErrorBox error={rooms.error} />}
    </Editor>
  );
}
export function DevicesPage() {
  const admin = useAuthStore((s) => s.user?.role === "ADMIN");
  const filter = useFilters();
  const rooms = useRooms();
  const query = usePage<DeviceRecord>("devices", "/devices", filter.params);
  const [editor, setEditor] = useState<ReactNode>();
  return (
    <>
      <Title
        action={
          admin && (
            <button
              className="primary"
              onClick={() =>
                setEditor(<DeviceEditor close={() => setEditor(null)} />)
              }
            >
              + Đăng ký thiết bị
            </button>
          )
        }
      >
        Thiết bị
      </Title>
      <Filters>
        <Choice
          label="Phòng"
          value={String(filter.params.room_id || "")}
          options={
            rooms.data?.map((room) => ({
              value: room.room_id,
              label: room.room_name,
            })) || []
          }
          onChange={(v) => filter.filter("room_id", v)}
        />
        <Choice
          label="Loại"
          value={String(filter.params.device_type || "")}
          options={["SENSOR_NODE", "CONTROL_NODE"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => filter.filter("device_type", v)}
        />
        <Choice
          label="Vòng đời"
          value={String(filter.params.lifecycle_status || "")}
          options={lifecycle}
          onChange={(v) => filter.filter("lifecycle_status", v)}
        />
        <Choice
          label="Kết nối"
          value={String(filter.params.connection_status || "")}
          options={["ONLINE", "OFFLINE", "UNKNOWN"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => filter.filter("connection_status", v)}
        />
      </Filters>
      <Paged
        query={query}
        change={filter.go}
        rowKey={(device) => device.device_id}
        columns={[
          {
            label: "Thiết bị",
            render: (d) => (
              <Link to={`/devices/${d.device_id}`}>
                {d.device_name || d.device_code}
              </Link>
            ),
          },
          {
            label: "Mã / loại",
            render: (d) => (
              <>
                {d.device_code}
                <small className="block muted">{d.device_type}</small>
              </>
            ),
          },
          {
            label: "Phòng",
            render: (d) =>
              rooms.data?.find((room) => room.room_id === d.room_id)
                ?.room_name || "Chưa gán",
          },
          {
            label: "Vòng đời",
            render: (d) => <StatusBadge status={d.lifecycle_status} />,
          },
          {
            label: "Kết nối",
            render: (d) => <StatusBadge status={d.connection_status} />,
          },
          {
            label: "Thao tác",
            render: (d) =>
              admin &&
              d.lifecycle_status !== "DECOMMISSIONED" && (
                <button
                  className="secondary"
                  onClick={() =>
                    setEditor(
                      <DeviceEditor device={d} close={() => setEditor(null)} />,
                    )
                  }
                >
                  Sửa
                </button>
              ),
          },
        ]}
      />
      {editor}
    </>
  );
}
function ConfigPanel({ device }: { device: DeviceRecord }) {
  const admin = useAuthStore((s) => s.user?.role === "ADMIN");
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState(false);
  const query = useQuery({
    queryKey: ["configs", device.device_id, page],
    queryFn: ({ signal }) =>
      envelope<ConfigData>(
        `/devices/${device.device_id}/configs`,
        { page, page_size: 10 },
        signal,
      ),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.data.history.some((config) => config.status === "PENDING")
        ? 3000
        : false,
  });
  const state = query.data?.data.state;
  const limits = query.data?.data.limits;
  const blockReason = deviceBlockReason(device, [
    "PROVISIONED",
    "ACTIVE",
    "FAULT",
    "MAINTENANCE",
  ]);
  return (
    <Card>
      <h3>Cấu hình từ xa</h3>
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {state ? (
            <div className="two-col">
              <div>
                <strong>Cấu hình mong muốn · v{state?.desired_version}</strong>
                <DetailData value={state?.desired_settings} />
              </div>
              <div>
                <strong>Đã áp dụng · v{state?.applied_version}</strong>
                <DetailData value={state?.applied_settings} />
              </div>
            </div>
          ) : (
            <Empty text="Chưa có cấu hình. Gán phòng và provision thiết bị trước khi cấu hình từ xa." />
          )}
          {state?.last_error_code && (
            <p className="form-error">{state.last_error_code}</p>
          )}
          <p className="muted small">
            Cấu hình chỉ được coi là áp dụng sau ACK của thiết bị.
          </p>
          {admin && (
            <button
              className="primary"
              disabled={!state || Boolean(blockReason)}
              onClick={() => setEdit(true)}
            >
              Đổi cấu hình
            </button>
          )}
          {admin && blockReason && <p className="muted small">{blockReason}</p>}
          <Table
            items={query.data?.data.history || []}
            rowKey={(row) => row.config_id}
            columns={[
              { label: "Phiên bản", render: (row) => row.version },
              {
                label: "Thiết lập",
                render: (row) => <DetailData value={row.settings} />,
              },
              {
                label: "Trạng thái",
                render: (row) => <StatusBadge status={row.status} />,
              },
              { label: "Lỗi", render: (row) => row.error_code || "—" },
              { label: "Thời gian", render: (row) => dateText(row.created_at) },
            ]}
          />
          <Pager
            page={page}
            size={10}
            total={query.data?.meta?.total || 0}
            change={setPage}
          />
        </>
      )}
      {edit && (
        <Editor
          title="Đổi cấu hình thiết bị"
          fields={[
            ...(device.device_type === "SENSOR_NODE"
              ? [
                  {
                    name: "sample_interval_seconds",
                    label: "Chu kỳ lấy mẫu (giây)",
                    type: "number" as const,
                    required: true,
                    min: 1,
                    max: limits?.sample_interval_seconds.max ?? 300,
                  },
                ]
              : []),
            {
              name: "heartbeat_interval_seconds",
              label: "Chu kỳ heartbeat (giây)",
              type: "number",
              required: true,
              min: 1,
              max: limits?.heartbeat_interval_seconds.max,
              hint: limits
                ? `Tối đa ${limits.heartbeat_interval_seconds.max} giây theo timeout hiện tại của hệ thống.`
                : "Backend sẽ kiểm tra giới hạn an toàn của heartbeat.",
            },
          ]}
          initial={Object.fromEntries(
            Object.entries(state?.desired_settings || {}).map(
              ([key, value]) => [key, String(value)],
            ),
          )}
          close={() => setEdit(false)}
          save={(values) =>
            write("POST", `/devices/${device.device_id}/configs`, {
              settings: Object.fromEntries(
                Object.entries(values).map(([key, value]) => [
                  key,
                  Number(value),
                ]),
              ),
            })
          }
        />
      )}
    </Card>
  );
}
export function DeviceDetailPage() {
  const { id = "" } = useParams();
  const admin = useAuthStore((s) => s.user?.role === "ADMIN");
  const query = useApi<DeviceRecord>("devices", `/devices/${id}`);
  const broker = useApi<{ broker_sync_status: string; operations: unknown[] }>(
    "broker",
    `/devices/${id}/broker-status`,
  );
  const historyFilter = useFilters();
  const [historyRange, setHistoryRange] = useState({ from: "", to: "" });
  const [historyError, setHistoryError] = useState<unknown>();
  const history = usePage<Record<string, unknown>>(
    "lifecycle",
    `/devices/${id}/lifecycle-events`,
    historyFilter.params,
  );
  const [editor, setEditor] = useState<ReactNode>();
  const [credentials, setCredentials] = useState<CredentialResult>();
  const [copied, setCopied] = useState(false);
  if (query.isLoading) return <Loading />;
  if (query.error)
    return <ErrorBox error={query.error} retry={() => void query.refetch()} />;
  const device = query.data;
  if (!device) return null;
  const act = (action: string, label: string, confirm = false) =>
    setEditor(
      <Editor
        title={`${label} · ${device.device_code}`}
        fields={[
          {
            name: "reason",
            label: "Lý do",
            required: true,
            minLength: 3,
            maxLength: 255,
          },
          ...(confirm
            ? [
                {
                  name: "confirmed",
                  label: "Tôi xác nhận thực hiện thao tác này",
                  type: "checkbox" as const,
                  required: true,
                },
              ]
            : []),
        ]}
        close={() => setEditor(null)}
        submitLabel={label}
        save={async (values) => {
          const result = await write<CredentialResult>(
            "POST",
            `/devices/${id}/${action}`,
            {
              reason: values.reason,
              ...(confirm ? { confirmed: values.confirmed === "true" } : {}),
            },
          );
          if (result.credentials) setCredentials(result);
        }}
      />,
    );
  const live = ["PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE"].includes(
    device.lifecycle_status,
  );
  return (
    <>
      <Title action={<Link to="/devices">← Danh sách thiết bị</Link>}>
        {device.device_name || device.device_code}
      </Title>
      <Card>
        <div className="detail-grid">
          {[
            ["Mã", device.device_code],
            ["Loại", device.device_type],
            ["Phòng", device.room_code || "Chưa gán"],
            ["Firmware", device.firmware_version],
            ["Heartbeat", dateText(device.last_heartbeat_at)],
            ["RSSI", device.last_rssi_dbm],
            ["Uptime (giây)", device.last_uptime_seconds],
            ["Heap (byte)", device.last_free_heap_bytes],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <span className="muted">{label}</span>
              <strong>{value ?? "—"}</strong>
            </div>
          ))}
        </div>
        <div className="user-actions">
          <StatusBadge status={device.lifecycle_status} />
          <StatusBadge status={device.connection_status} />
        </div>
        {device.device_type === "CONTROL_NODE" && (
          <p>
            <Link
              to={`/control?device_id=${device.device_id}&room_id=${device.room_id || ""}`}
            >
              Xem trạng thái và lịch sử điều khiển →
            </Link>
          </p>
        )}
        {admin && device.lifecycle_status !== "DECOMMISSIONED" && (
          <div className="device-actions">
            <button
              className="secondary"
              onClick={() =>
                setEditor(
                  <DeviceEditor
                    device={device}
                    close={() => setEditor(null)}
                  />,
                )
              }
            >
              Sửa thông tin
            </button>
            {["REGISTERED", "REVOKED"].includes(device.lifecycle_status) && (
              <button
                className="primary"
                disabled={!device.room_id}
                onClick={() =>
                  act(
                    "provision",
                    "Cấp credential",
                    device.lifecycle_status === "REVOKED",
                  )
                }
              >
                Provision
              </button>
            )}
            {device.lifecycle_status === "PROVISIONED" && (
              <button
                className="primary"
                onClick={() => act("activate", "Kích hoạt")}
              >
                Kích hoạt
              </button>
            )}
            {live && (
              <>
                <button
                  className="secondary"
                  onClick={() =>
                    act("rotate-credentials", "Xoay credential", true)
                  }
                >
                  Xoay credential
                </button>
                <button
                  className="secondary"
                  onClick={() => act("revoke", "Thu hồi credential", true)}
                >
                  Thu hồi
                </button>
              </>
            )}
            {["ACTIVE", "FAULT"].includes(device.lifecycle_status) && (
              <button
                className="secondary"
                onClick={() => act("maintenance", "Bảo trì")}
              >
                Bảo trì
              </button>
            )}
            {["MAINTENANCE", "FAULT"].includes(device.lifecycle_status) && (
              <button
                className="secondary"
                onClick={() => act("recover", "Khôi phục hoạt động")}
              >
                Khôi phục
              </button>
            )}
            {["REGISTERED", "REVOKED"].includes(device.lifecycle_status) && (
              <button
                className="secondary"
                onClick={() =>
                  act("decommission", "Ngừng sử dụng vĩnh viễn", true)
                }
              >
                Ngừng sử dụng
              </button>
            )}
          </div>
        )}
      </Card>
      {credentials?.credentials && (
        <Card>
          <h3>Credential mới · chỉ hiển thị một lần</h3>
          <p>
            Trạng thái đồng bộ:{" "}
            <StatusBadge status={credentials.operation.status} />
          </p>
          <DetailData value={credentials.credentials} />
          <div className="user-actions">
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(credentials.credentials, null, 2),
                  );
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Đã sao chép" : "Sao chép cấu hình"}
            </button>
            <button
              className="secondary"
              onClick={() => setCredentials(undefined)}
            >
              Ẩn credential
            </button>
          </div>
        </Card>
      )}
      <Card>
        <h3>Đồng bộ MQTT broker</h3>
        {broker.error ? (
          <ErrorBox error={broker.error} retry={() => void broker.refetch()} />
        ) : broker.data ? (
          <>
            <StatusBadge status={broker.data.broker_sync_status} />
            <DetailData value={broker.data.operations} />
            <button className="secondary" onClick={() => void broker.refetch()}>
              Cập nhật trạng thái đồng bộ
            </button>
          </>
        ) : (
          <Loading />
        )}
      </Card>
      <ConfigPanel device={device} />
      <h3>Lịch sử vòng đời</h3>
      <Filters>
        <Choice
          label="Chuyển từ"
          value={String(historyFilter.params.from_status || "")}
          options={lifecycle}
          onChange={(v) => historyFilter.filter("from_status", v)}
        />
        <Choice
          label="Chuyển đến"
          value={String(historyFilter.params.to_status || "")}
          options={lifecycle}
          onChange={(v) => historyFilter.filter("to_status", v)}
        />
        <Choice
          label="Loại người thực hiện"
          value={String(historyFilter.params.actor_type || "")}
          options={["USER", "DEVICE", "SYSTEM"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(v) => historyFilter.filter("actor_type", v)}
        />
        <label>
          ID người thực hiện
          <input
            type="number"
            min="1"
            value={String(historyFilter.params.actor_id || "")}
            onChange={(event) =>
              historyFilter.filter("actor_id", event.target.value)
            }
          />
        </label>
        <label>
          Từ
          <input
            type="datetime-local"
            step="1"
            value={historyRange.from}
            onChange={(event) =>
              setHistoryRange({ ...historyRange, from: event.target.value })
            }
          />
        </label>
        <label>
          Đến
          <input
            type="datetime-local"
            step="1"
            value={historyRange.to}
            onChange={(event) =>
              setHistoryRange({ ...historyRange, to: event.target.value })
            }
          />
        </label>
        <button
          className="secondary"
          onClick={() => {
            try {
              const range =
                !historyRange.from && !historyRange.to
                  ? { from: "", to: "" }
                  : timeRange(historyRange.from, historyRange.to, Infinity);
              historyFilter.filter("from", range.from);
              historyFilter.filter("to", range.to);
              setHistoryError(undefined);
            } catch (error) {
              setHistoryError(error);
            }
          }}
        >
          Lọc thời gian
        </button>
      </Filters>
      {historyError && <ErrorBox error={historyError} />}
      <Paged
        query={history}
        change={historyFilter.go}
        rowKey={(row) => String(row.event_id)}
        columns={[
          {
            label: "Thời gian",
            render: (row) => dateText(String(row.created_at)),
          },
          { label: "Từ", render: (row) => String(row.from_status || "—") },
          {
            label: "Đến",
            render: (row) => <StatusBadge status={String(row.to_status)} />,
          },
          { label: "Lý do", render: (row) => String(row.reason || "—") },
          {
            label: "Người thực hiện",
            render: (row) => `${row.actor_type} ${row.actor_id || ""}`,
          },
        ]}
      />
      {editor}
    </>
  );
}
