import {
  rooms as sampleRooms,
  devices as sampleDevices,
  alerts as sampleAlerts,
  latest,
  users,
} from "../mocks/data";
import { useAuthStore } from "../store/auth";
import type { Envelope } from "./resources";
import type { Params } from "./resource-types";
import { mockTelemetryStats } from "./mock-telemetry";
type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const rooms: Row[] = sampleRooms.map((room) => ({ ...room, room_id: room.id }));
const devices: Row[] = sampleDevices.map((device) => ({
  ...device,
  device_id: device.id,
  device_name: device.device_code,
  broker_sync_status: "SYNCED",
  hardware_version: "ESP32",
  room_code: sampleRooms.find((room) => room.id === device.room_id)?.room_code,
  last_heartbeat_at: device.last_seen,
  last_rssi_dbm: device.wifi_rssi_dbm,
  last_free_heap_bytes: device.free_heap_bytes,
  last_uptime_seconds: device.uptime_seconds,
  control_mode: "MANUAL",
}));
const alerts: Row[] = sampleAlerts.map((alert) => ({
  ...alert,
  alert_id: alert.id,
  room_id: alert.room_name?.includes("B202") ? "r2" : "r1",
  device_id: "d1",
}));
const telemetry: Row[] = Array.from({ length: 12 }, (_, i) => ({
  ...latest,
  data_id: String(i + 1),
  device_id: "d1",
  room_id: "r1",
  recorded_at: new Date(Date.now() - (12 - i) * 60000).toISOString(),
  received_at: now(),
  temperature: 26 + i / 10,
}));
const commands: Row[] = [],
  rules: Row[] = [],
  firmware: Row[] = [],
  jobs: Row[] = [],
  audit: Row[] = [],
  logs: Row[] = [];
const memberships = new Map<string, string[]>([
  ["r1", ["u2", "u3"]],
  ["r2", []],
]);
const desired = new Map<string, Row>(),
  reported = new Map<string, Row>(),
  configs = new Map<string, Row[]>(),
  settings = new Map<string, Row>(),
  thresholds = new Map<string, Row[]>();
const lifecycleEvents: Row[] = [];
const idempotentCommands = new Map<
  string,
  { request: string; response: unknown; expiresAt: number }
>();
for (const device of devices.filter(
  (row) => row.device_type === "CONTROL_NODE",
)) {
  reported.set(String(device.device_id), {
    light: latest.light_state,
    fan: latest.fan_state,
  });
}
function transition(device: Row, to: string, reason: unknown) {
  lifecycleEvents.unshift({
    event_id: crypto.randomUUID(),
    device_id: device.device_id,
    from_status: device.lifecycle_status ?? null,
    to_status: to,
    reason: reason || "Thao tác mô phỏng",
    actor_type: "USER",
    actor_id: actor()?.id,
    created_at: now(),
  });
  device.lifecycle_status = to;
}
function fail(message: string): never {
  throw new Error(message);
}
function actor() {
  return useAuthStore.getState().user;
}
function admin() {
  if (actor()?.role !== "ADMIN") fail("Chỉ Admin được thực hiện thao tác này.");
}
function scope(room: unknown) {
  return (
    actor()?.role === "ADMIN" ||
    Boolean(room && memberships.get(String(room))?.includes(actor()?.id || ""))
  );
}
function getDevice(id: string) {
  const device = devices.find((row) => row.device_id === id);
  if (!device || !scope(device.room_id))
    fail("Không tìm thấy thiết bị trong phạm vi truy cập.");
  device.room_status = rooms.find(
    (room) => room.room_id === device.room_id,
  )?.status;
  device.room_code = rooms.find(
    (room) => room.room_id === device.room_id,
  )?.room_code;
  return device;
}
function record(action: string, target: string) {
  audit.unshift({
    log_id: crypto.randomUUID(),
    actor_type: "USER",
    actor_id: actor()?.id,
    action,
    target_type: target,
    result: "SUCCESS",
    created_at: now(),
    request_id: crypto.randomUUID(),
    details: { mock: true },
  });
}
function result<T>(data: T): Envelope<T> {
  return { success: true, data: structuredClone(data) };
}
function paginate(rows: Row[], query: Params): Envelope<Row[]> {
  let filtered = rows.filter((row) =>
    Object.entries(query).every(
      ([key, value]) =>
        ["page", "page_size", "from", "to", "bucket"].includes(key) ||
        value === undefined ||
        value === "" ||
        (key === "search"
          ? JSON.stringify(row)
              .toLowerCase()
              .includes(String(value).toLowerCase())
          : String(row[key]) === String(value)),
    ),
  );
  if (query.from)
    filtered = filtered.filter(
      (row) =>
        String(row.recorded_at || row.created_at || "") >= String(query.from),
    );
  if (query.to)
    filtered = filtered.filter(
      (row) =>
        String(row.recorded_at || row.created_at || "") < String(query.to),
    );
  const page = Number(query.page || 1),
    size = Number(query.page_size || 20);
  return {
    success: true,
    data: structuredClone(filtered.slice((page - 1) * size, page * size)),
    meta: {
      page,
      page_size: size,
      total: filtered.length,
      from: query.from ? String(query.from) : undefined,
      to: query.to ? String(query.to) : undefined,
    },
  };
}
function userRows(): Row[] {
  return users.map((user) => ({ ...user, user_id: user.id }));
}
export async function mockResource(
  method: string,
  path: string,
  input: unknown,
  query: Params,
  headers?: Record<string, string>,
): Promise<Envelope<unknown>> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!actor()) fail("Vui lòng đăng nhập.");
  const body = (input || {}) as Row;
  const [kind, id, action] = path.split("/").filter(Boolean);
  for (const command of commands)
    if (command.status === "PENDING" && String(command.timeout_at) < now())
      command.status = "TIMEOUT";
  if (
    method !== "GET" &&
    !["commands", "control-mode", "acknowledge", "resolve"].includes(action)
  )
    admin();
  if (
    ["commands", "control-mode", "acknowledge", "resolve"].includes(action) &&
    method !== "GET" &&
    actor()?.role === "VIEWER"
  )
    fail("Viewer chỉ có quyền xem.");
  if (kind === "rooms") {
    if (action === "users") {
      admin();
      if (method === "PUT") {
        memberships.set(id, (body.user_ids || []) as string[]);
        record("ROOM_MEMBERS_UPDATE", "ROOM");
      }
      return result(
        userRows().filter((row) =>
          memberships.get(id)?.includes(String(row.user_id)),
        ),
      );
    }
    if (action === "alert-thresholds") {
      if (!scope(id)) fail("Không có quyền xem phòng.");
      if (method === "PUT") thresholds.set(id, body.thresholds as Row[]);
      return result(
        thresholds.get(id) ||
          ["TEMPERATURE", "HUMIDITY"].flatMap((sensor_type) =>
            ["WARNING", "CRITICAL"].map((severity) => ({
              sensor_type,
              severity,
              operator: "GT",
              threshold_value:
                sensor_type === "TEMPERATURE"
                  ? severity === "WARNING"
                    ? 30
                    : 35
                  : severity === "WARNING"
                    ? 75
                    : 90,
              clear_value: sensor_type === "TEMPERATURE" ? 28 : 70,
              is_enabled: true,
            })),
          ),
      );
    }
    if (action === "automation-rules") {
      if (!scope(id)) fail("Không có quyền xem phòng.");
      if (method === "POST") {
        const rule = { ...body, rule_id: crypto.randomUUID(), room_id: id };
        rules.push(rule);
        return result(rule);
      }
      return paginate(
        rules.filter((row) => row.room_id === id),
        query,
      );
    }
    if (action === "telemetry") {
      if (!scope(id)) fail("Không có quyền xem phòng.");
      const samples = telemetry
        .filter((row) => row.room_id === id)
        .sort((a, b) =>
          String(b.recorded_at).localeCompare(String(a.recorded_at)),
        );
      if (path.endsWith("/latest")) return paginate(samples.slice(0, 1), query);
      if (path.endsWith("/stats"))
        return result(mockTelemetryStats(samples, query));
      return paginate(samples, query);
    }
    if (method === "POST") {
      if (rooms.some((row) => row.room_code === body.room_code))
        fail("Mã phòng đã tồn tại.");
      const room = { ...body, room_id: crypto.randomUUID(), status: "ACTIVE" };
      rooms.push(room);
      record("ROOM_CREATE", "ROOM");
      return result(room);
    }
    if (id) {
      const room = rooms.find((row) => row.room_id === id);
      if (!room || !scope(id)) fail("Không tìm thấy phòng.");
      if (method === "PATCH") {
        Object.assign(room, body);
        record("ROOM_UPDATE", "ROOM");
      }
      return result({
        ...room,
        devices: devices.filter((device) => device.room_id === id),
      });
    }
    return paginate(
      rooms.filter((row) => scope(row.room_id)),
      query,
    );
  }
  if (kind === "users") {
    admin();
    return paginate(userRows(), query);
  }
  if (kind === "devices") {
    if (!id) {
      if (method === "POST") {
        if (devices.some((row) => row.device_code === body.device_code))
          fail("Mã thiết bị đã tồn tại.");
        if (
          body.room_id &&
          !rooms.some((room) => room.room_id === body.room_id)
        )
          fail("Phòng không tồn tại.");
        const device = {
          ...body,
          device_id: crypto.randomUUID(),
          room_id: body.room_id || null,
          lifecycle_status: null,
          connection_status: "UNKNOWN",
          broker_sync_status: "PENDING",
          created_at: now(),
        };
        transition(device, "REGISTERED", "Đăng ký thiết bị");
        devices.push(device);
        record("DEVICE_REGISTER", "DEVICE");
        return result(device);
      }
      return paginate(
        devices
          .filter((row) => scope(row.room_id))
          .map((row) => ({
            ...row,
            room_status: rooms.find((room) => room.room_id === row.room_id)
              ?.status,
          })),
        query,
      );
    }
    const device = getDevice(id);
    if (!action) {
      if (method === "PATCH") {
        Object.assign(device, body);
        record("DEVICE_UPDATE", "DEVICE");
      }
      return result(device);
    }
    if (action === "shadow")
      return result({
        device_id: id,
        desired_state: desired.get(id) || { light: "UNKNOWN", fan: "UNKNOWN" },
        reported_state: reported.get(id) || {
          light: "UNKNOWN",
          fan: "UNKNOWN",
        },
        shadow_version: 1,
        reported_version: 0,
        in_sync: false,
        latest_command: commands.find((row) => row.device_id === id),
      });
    if (action === "commands") {
      if (method === "POST") {
        const key = headers?.["Idempotency-Key"];
        const request = JSON.stringify({
          device_id: id,
          actor_id: actor()?.id,
          ...body,
        });
        const cached = key ? idempotentCommands.get(key) : undefined;
        if (cached && cached.expiresAt > Date.now()) {
          if (cached.request !== request)
            fail("Mã yêu cầu đã được dùng cho nội dung khác.");
          return result({ ...(cached.response as Row), cached: true });
        }
        if (
          device.lifecycle_status !== "ACTIVE" ||
          device.connection_status !== "ONLINE"
        )
          fail("Thiết bị chưa sẵn sàng.");
        const command = {
          command_id: crypto.randomUUID(),
          device_id: id,
          room_id: device.room_id,
          desired_state: body.desired_state,
          status: "PENDING",
          source: "MANUAL",
          created_at: now(),
          timeout_at: new Date(Date.now() + 5000).toISOString(),
        };
        commands.unshift(command);
        desired.set(id, { ...desired.get(id), ...(body.desired_state as Row) });
        record("COMMAND_CREATE", "COMMAND");
        const response = { command, cached: false, shadow: {} };
        if (key)
          idempotentCommands.set(key, {
            request,
            response,
            expiresAt: Date.now() + 60000,
          });
        return result(response);
      }
      return paginate(
        commands.filter((row) => row.device_id === id),
        query,
      );
    }
    if (action === "control-mode") {
      device.control_mode = body.control_mode;
      return result(device);
    }
    if (action === "configs") {
      const state = settings.get(id) || {
        desired_version: 1,
        applied_version: 1,
        desired_settings: {
          ...(device.device_type === "SENSOR_NODE"
            ? { sample_interval_seconds: 10 }
            : {}),
          heartbeat_interval_seconds: 10,
        },
        applied_settings: {
          ...(device.device_type === "SENSOR_NODE"
            ? { sample_interval_seconds: 10 }
            : {}),
          heartbeat_interval_seconds: 10,
        },
      };
      if (method === "POST") {
        if (
          Number((body.settings as Row)?.heartbeat_interval_seconds || 0) > 10
        )
          fail("Chu kỳ heartbeat tối đa 10 giây.");
        state.desired_version = Number(state.desired_version) + 1;
        state.desired_settings = {
          ...(state.desired_settings as Row),
          ...(body.settings as Row),
        };
        settings.set(id, state);
        const config = {
          config_id: crypto.randomUUID(),
          version: state.desired_version,
          settings: state.desired_settings,
          status: "PENDING",
          created_at: now(),
        };
        configs.set(id, [config, ...(configs.get(id) || [])]);
        return result(config);
      }
      const paged = paginate(configs.get(id) || [], query);
      return {
        ...paged,
        data: {
          state: structuredClone(state),
          history: paged.data,
          limits: {
            sample_interval_seconds: { min: 1, max: 300 },
            heartbeat_interval_seconds: { min: 1, max: 10 },
          },
        },
      };
    }
    if (action === "lifecycle-events")
      return paginate(
        lifecycleEvents.filter((row) => row.device_id === id),
        query,
      );
    if (action === "broker-status")
      return result({
        broker_sync_status: device.broker_sync_status,
        operations: [],
      });
    if (["provision", "rotate-credentials"].includes(action)) {
      if (!device.room_id) fail("Cần gán phòng trước khi provision.");
      if (action === "rotate-credentials" && body.confirmed !== true)
        fail("Cần xác nhận xoay credential.");
      if (action === "provision")
        transition(device, "PROVISIONED", body.reason);
      device.broker_sync_status = "SYNCED";
      record("DEVICE_" + action.toUpperCase().replace(/-/g, "_"), "DEVICE");
      return result({
        operation: { operation_id: crypto.randomUUID(), status: "APPLIED" },
        credentials: {
          username: device.device_code,
          client_id: device.device_code,
          room_code: rooms.find((room) => room.room_id === device.room_id)
            ?.room_code,
          password: "mock-" + crypto.randomUUID(),
          mqtt_url: "mqtt://demo.invalid:1883",
        },
      });
    }
    if (action === "ota") {
      const release = firmware.find(
        (row) =>
          row.firmware_id === body.firmware_id && row.status === "PUBLISHED",
      );
      if (
        !release ||
        release.device_type !== device.device_type ||
        release.hardware_target !== device.hardware_version
      )
        fail("Firmware không tương thích với thiết bị.");
      if (jobs.some((row) => row.device_id === id && row.status === "PENDING"))
        fail("Thiết bị đang có yêu cầu OTA.");
      const job = {
        job_id: crypto.randomUUID(),
        device_id: id,
        room_id: device.room_id,
        firmware_id: body.firmware_id,
        status: "PENDING",
        progress: 0,
        created_at: now(),
      };
      jobs.unshift(job);
      return result(job);
    }
    if (action === "decommission" && body.confirmed !== true)
      fail("Cần xác nhận ngừng sử dụng.");
    if (action === "revoke" && body.confirmed !== true)
      fail("Cần xác nhận thu hồi.");
    if (action === "activate" && device.connection_status !== "ONLINE")
      fail("Chưa có heartbeat từ thiết bị mô phỏng.");
    const to = (
      {
        maintenance: "MAINTENANCE",
        resume: "ACTIVE",
        "clear-fault": "ACTIVE",
        recover: "ACTIVE",
        activate: "ACTIVE",
        revoke: "REVOKED",
        decommission: "DECOMMISSIONED",
      } as Record<string, string>
    )[action];
    if (!to) fail("Thao tác vòng đời không được hỗ trợ.");
    transition(device, to, body.reason);
    record("DEVICE_" + action.toUpperCase(), "DEVICE");
    return result(device);
  }
  if (kind === "alerts") {
    const scoped = alerts.filter((row) => scope(row.room_id));
    if (id) {
      const alert = scoped.find((row) => row.alert_id === id);
      if (!alert) fail("Không tìm thấy cảnh báo.");
      if (action) {
        alert.status = action === "resolve" ? "RESOLVED" : "ACKNOWLEDGED";
        alert.resolution_note = body.reason;
        record("ALERT_" + action.toUpperCase(), "ALERT");
      }
      return result(alert);
    }
    return paginate(scoped, query);
  }
  if (kind === "automation-rules") {
    const rule = rules.find((row) => row.rule_id === id);
    if (!rule) fail("Không tìm thấy quy tắc.");
    Object.assign(rule, body);
    return result(rule);
  }
  if (kind === "audit-logs") {
    admin();
    return paginate(audit, query);
  }
  if (kind === "anomalies")
    return id
      ? fail("Chưa có kết quả bất thường mô phỏng.")
      : paginate([], query);
  if (kind === "monitoring") {
    admin();
    if (id === "logs") return paginate(logs, query);
    return result({
      generatedAt: now(),
      components: [{ name: "mock", status: "UP" }],
      devices: devices.filter((row) => scope(row.room_id)),
      counters: { mock_requests: 1 },
    });
  }
  if (kind === "ota") {
    if (id === "firmware") {
      if (method === "POST" && !action) {
        const row = {
          ...body,
          firmware_id: crypto.randomUUID(),
          status: "DRAFT",
          sha256: "demo",
          created_at: now(),
        };
        firmware.unshift(row);
        return result(row);
      }
      if (action) {
        const row = firmware.find((row) => row.firmware_id === action);
        if (!row) fail("Không tìm thấy firmware.");
        if (method === "POST") {
          if (
            path.endsWith("/revoke") &&
            jobs.some(
              (job) =>
                job.firmware_id === row.firmware_id && job.status === "PENDING",
            )
          )
            fail("Không thể thu hồi firmware đang có job hoạt động.");
          row.status = path.endsWith("/publish") ? "PUBLISHED" : "REVOKED";
        }
        return result(row);
      }
      return paginate(
        firmware.filter(
          (row) => actor()?.role === "ADMIN" || row.status === "PUBLISHED",
        ),
        query,
      );
    }
    if (id === "jobs")
      return paginate(
        jobs.filter((row) =>
          scope(
            devices.find((device) => device.device_id === row.device_id)
              ?.room_id,
          ),
        ),
        query,
      );
  }
  if (kind === "dashboard") {
    const samples = telemetry.filter(
      (row) =>
        scope(row.room_id) && (!query.room_id || row.room_id === query.room_id),
    );
    return result({
      rooms_count: rooms.filter((row) => scope(row.room_id)).length,
      device_counts: [],
      unresolved_alert_counts: [],
      latest_telemetry: samples
        .slice(-1)
        .map((row) => ({
          ...row,
          stale: Date.now() - Date.parse(String(row.recorded_at)) > 30000,
          fresh_until: new Date(
            Date.parse(String(row.recorded_at)) + 30000,
          ).toISOString(),
        })),
      generated_at: now(),
    });
  }
  fail("Chức năng mô phỏng chưa được hỗ trợ: " + path);
}
