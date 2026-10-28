export class InMemoryMonitoringRepository {
  constructor() {
    this.components = new Map();
    this.devices = new Map();
    this.counters = new Map();
  }

  async setComponent(
    name,
    status,
    details = {},
    timestamp = new Date().toISOString(),
  ) {
    const record = {
      name,
      status,
      details: structuredClone(details),
      updatedAt: timestamp,
    };
    this.components.set(name, record);
    return structuredClone(record);
  }

  async getComponents() {
    return [...this.components.values()].map((item) => structuredClone(item));
  }

  async recordHeartbeat(
    deviceId,
    metadata = {},
    timestamp = new Date().toISOString(),
  ) {
    const record = {
      deviceId,
      lastSeenAt: timestamp,
      metadata: structuredClone(metadata),
    };
    this.devices.set(deviceId, record);
    return structuredClone(record);
  }

  async getDevices() {
    return [...this.devices.values()].map((item) => structuredClone(item));
  }

  async incrementCounter(name, amount = 1) {
    const next = (this.counters.get(name) ?? 0) + amount;
    this.counters.set(name, next);
    return next;
  }

  async getCounters() {
    return Object.fromEntries(this.counters.entries());
  }
}
