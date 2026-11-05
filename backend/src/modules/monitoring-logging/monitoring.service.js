import { MonitoringError } from "./monitoring.errors.js";

const COMPONENT_STATUSES = new Set(["UP", "DEGRADED", "DOWN", "UNKNOWN"]);
const LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);

export class MonitoringService {
  constructor({
    repository,
    logger,
    now = () => new Date().toISOString(),
    offlineAfterMs = 60000,
  }) {
    if (!repository || !logger) throw new TypeError("Cần repository và logger");
    if (!Number.isFinite(offlineAfterMs) || offlineAfterMs <= 0)
      throw new TypeError("offlineAfterMs phải là số dương");
    this.repository = repository;
    this.logger = logger;
    this.now = now;
    this.offlineAfterMs = offlineAfterMs;
  }

  async setComponentStatus(name, status, details = {}) {
    if (typeof name !== "string" || !name.trim())
      throw new MonitoringError(
        "Tên component không hợp lệ",
        "INVALID_COMPONENT",
      );
    if (!COMPONENT_STATUSES.has(status))
      throw new MonitoringError(
        "Trạng thái component không hợp lệ",
        "INVALID_STATUS",
      );
    if (!details || typeof details !== "object" || Array.isArray(details))
      throw new MonitoringError("Details không hợp lệ", "INVALID_DETAILS");

    const record = { name, status, details, updatedAt: this.now() };
    await this.repository.setComponent(name, status, details, record.updatedAt);
    this.logger.info("monitoring.component_status_updated", record);
    return record;
  }

  async recordHeartbeat(deviceId, metadata = {}, timestamp = this.now()) {
    // Trạng thái kết nối thực tế do DevicePresenceService quản lý trong PostgreSQL.
    // Chỉ repository in-memory dùng phương thức này cho unit test độc lập.
    if (typeof this.repository.recordHeartbeat !== "function") {
      throw new MonitoringError(
        "Heartbeat phải được xử lý bởi DevicePresenceService",
        "HEARTBEAT_OWNED_BY_PRESENCE",
      );
    }
    if (typeof deviceId !== "string" || !deviceId.trim())
      throw new MonitoringError("deviceId không hợp lệ", "INVALID_DEVICE_ID");
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time))
      throw new MonitoringError(
        "Timestamp heartbeat không hợp lệ",
        "INVALID_TIMESTAMP",
      );
    return this.repository.recordHeartbeat(
      deviceId,
      metadata,
      new Date(time).toISOString(),
    );
  }

  async recordEvent(
    name,
    {
      amount = 1,
      level = "INFO",
      message = "Monitoring event",
      metadata = {},
    } = {},
  ) {
    if (typeof name !== "string" || !name.trim())
      throw new MonitoringError("Tên counter không hợp lệ", "INVALID_COUNTER");
    if (!Number.isInteger(amount) || amount <= 0)
      throw new MonitoringError(
        "amount phải là số nguyên dương",
        "INVALID_AMOUNT",
      );
    if (!LOG_LEVELS.has(level))
      throw new MonitoringError("Log level không hợp lệ", "INVALID_LOG_LEVEL");
    if (typeof message !== "string" || !message.trim())
      throw new MonitoringError("Message không được rỗng", "INVALID_MESSAGE");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new MonitoringError("Metadata không hợp lệ", "INVALID_METADATA");

    const value = await this.repository.incrementCounter(name, amount);
    this.logger.log(level, message, {
      counter: name,
      amount,
      total: value,
      ...metadata,
    });
    return value;
  }

  async getSnapshot() {
    const generatedAt = this.now();
    const nowMs = Date.parse(generatedAt);
    if (!Number.isFinite(nowMs))
      throw new MonitoringError("Đồng hồ hệ thống trả timestamp không hợp lệ");

    const [components, devices, counters] = await Promise.all([
      this.repository.getComponents(),
      this.repository.getDevices(),
      this.repository.getCounters(),
    ]);

    const deviceStatuses = devices.map((device) => {
      const lastSeenMs = device.lastSeenAt
        ? Date.parse(device.lastSeenAt)
        : NaN;
      const ageMs = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : null;
      const online =
        device.connectionStatus === "ONLINE" &&
        ageMs !== null &&
        ageMs >= 0 &&
        ageMs <= this.offlineAfterMs;
      return {
        ...device,
        online,
        ageMs,
        presenceStatus: online ? "ONLINE" : "OFFLINE",
        offlineReason: online
          ? null
          : ageMs === null
            ? "NO_HEARTBEAT"
            : ageMs < 0
              ? "INVALID_TIMESTAMP"
              : "HEARTBEAT_TIMEOUT",
      };
    });

    return {
      generatedAt,
      components,
      devices: deviceStatuses,
      counters,
      summary: {
        componentCount: components.length,
        componentUp: components.filter((item) => item.status === "UP").length,
        componentDegraded: components.filter(
          (item) => item.status === "DEGRADED",
        ).length,
        componentDown: components.filter((item) => item.status === "DOWN")
          .length,
        deviceCount: deviceStatuses.length,
        deviceOnline: deviceStatuses.filter((item) => item.online).length,
        deviceOffline: deviceStatuses.filter((item) => !item.online).length,
      },
    };
  }
}

export function bindMonitoring(runtime, monitoring) {
  const handler = async (envelope) => {
    try {
      await monitoring.recordEvent(`mqtt.${envelope.kind}.received`, {
        level: "DEBUG",
        message: "mqtt.device_message_received",
        metadata: {
          roomCode: envelope.roomCode,
          deviceCode: envelope.deviceCode,
          kind: envelope.kind,
        },
      });
    } catch (error) {
      // Monitoring là chức năng phụ trợ, không được chặn handler nghiệp vụ MQTT.
      monitoring.logger.warn("monitoring.event_record_failed", {
        kind: envelope.kind,
        code: error.code ?? "MONITORING_ERROR",
      });
    }
  };

  runtime.on("device-message", handler);
  return () => runtime.off("device-message", handler);
}
