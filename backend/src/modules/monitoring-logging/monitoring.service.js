import { MonitoringError } from "./monitoring.errors.js";

const COMPONENT_STATUSES = new Set(["UP", "DEGRADED", "DOWN", "UNKNOWN"]);

export class MonitoringService {
  constructor({
    repository,
    logger,
    now = () => new Date().toISOString(),
    offlineAfterMs = 60000,
  }) {
    if (!repository || !logger) throw new TypeError("Cần repository và logger");
    if (!Number.isFinite(offlineAfterMs) || offlineAfterMs <= 0) {
      throw new TypeError("offlineAfterMs phải là số dương");
    }
    this.repository = repository;
    this.logger = logger;
    this.now = now;
    this.offlineAfterMs = offlineAfterMs;
  }

  async setComponentStatus(name, status, details = {}) {
    if (typeof name !== "string" || !name.trim()) {
      throw new MonitoringError(
        "Tên component không hợp lệ",
        "INVALID_COMPONENT",
      );
    }
    if (!COMPONENT_STATUSES.has(status)) {
      throw new MonitoringError(
        "Trạng thái component không hợp lệ",
        "INVALID_STATUS",
      );
    }

    const record = {
      name,
      status,
      details,
      updatedAt: this.now(),
    };

    // Repository hiện tại nhận record có timestamp do service cung cấp.
    await this.repository.setComponent(name, status, details, record.updatedAt);
    this.logger.info("Component status updated", record);
    return record;
  }

  async recordHeartbeat(deviceId, metadata = {}, timestamp = this.now()) {
    if (typeof deviceId !== "string" || !deviceId.trim()) {
      throw new MonitoringError("deviceId không hợp lệ", "INVALID_DEVICE_ID");
    }
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      throw new MonitoringError(
        "Timestamp heartbeat không hợp lệ",
        "INVALID_TIMESTAMP",
      );
    }

    const record = await this.repository.recordHeartbeat(
      deviceId,
      metadata,
      new Date(time).toISOString(),
    );
    this.logger.debug("Device heartbeat received", {
      deviceId,
      lastSeenAt: record.lastSeenAt,
    });
    return record;
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
    if (typeof name !== "string" || !name.trim()) {
      throw new MonitoringError("Tên counter không hợp lệ", "INVALID_COUNTER");
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new MonitoringError(
        "amount phải là số nguyên dương",
        "INVALID_AMOUNT",
      );
    }
    if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(level)) {
      throw new MonitoringError("Log level không hợp lệ", "INVALID_LOG_LEVEL");
    }

    if (typeof message !== "string" || !message.trim()) {
      throw new MonitoringError("Message không được rỗng", "INVALID_MESSAGE");
    }

    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new MonitoringError("Metadata không hợp lệ", "INVALID_METADATA");
    }

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
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs))
      throw new MonitoringError("Đồng hồ hệ thống trả timestamp không hợp lệ");

    const [components, devices, counters] = await Promise.all([
      this.repository.getComponents(),
      this.repository.getDevices(),
      this.repository.getCounters(),
    ]);

    const deviceStatuses = devices.map((device) => {
      const ageMs = nowMs - Date.parse(device.lastSeenAt);
      const online = ageMs >= 0 && ageMs <= this.offlineAfterMs;
      return {
        ...device,
        online,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
      };
    });

    return {
      generatedAt: this.now(),
      components,
      devices: deviceStatuses,
      counters,
      summary: {
        componentCount: components.length,
        componentDown: components.filter((item) => item.status === "DOWN")
          .length,
        deviceCount: deviceStatuses.length,
        deviceOnline: deviceStatuses.filter((item) => item.online).length,
        deviceOffline: deviceStatuses.filter((item) => !item.online).length,
      },
    };
  }
}
