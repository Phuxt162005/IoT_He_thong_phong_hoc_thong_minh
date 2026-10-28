export class InMemoryDeviceShadowRepository {
  constructor() {
    this.shadows = new Map();
    this.commands = new Map();
  }

  async registerDevice({
    deviceId,
    roomCode,
    reportedState = { light: "OFF", fan: "OFF" },
  }) {
    if (this.shadows.has(deviceId))
      throw new Error(`Device already exists: ${deviceId}`);
    const now = new Date().toISOString();
    const shadow = {
      deviceId,
      roomCode,
      desiredState: { ...reportedState },
      reportedState: { ...reportedState },
      version: 1,
      updatedAt: now,
      lastReportedAt: now,
      lastCommandError: null,
    };
    this.shadows.set(deviceId, shadow);
    return structuredClone(shadow);
  }

  async getShadow(deviceId) {
    const value = this.shadows.get(deviceId);
    return value ? structuredClone(value) : null;
  }

  async saveShadow(shadow) {
    this.shadows.set(shadow.deviceId, structuredClone(shadow));
    return structuredClone(shadow);
  }

  async saveCommand(command) {
    this.commands.set(command.commandId, structuredClone(command));
    return structuredClone(command);
  }

  async getCommand(commandId) {
    const value = this.commands.get(commandId);
    return value ? structuredClone(value) : null;
  }

  async updateCommand(commandId, patch) {
    const current = this.commands.get(commandId);
    if (!current) return null;
    const updated = { ...current, ...structuredClone(patch) };
    this.commands.set(commandId, updated);
    return structuredClone(updated);
  }

  async getLatestCommandForDevice(deviceId) {
    const list = [...this.commands.values()]
      .filter((command) => command.deviceId === deviceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.length ? structuredClone(list[0]) : null;
  }
}
