import { randomUUID } from "node:crypto";
import { DeviceShadowError } from "./device-shadow.errors.js";
import { buildDeviceCommandTopic } from "./device-shadow.mqtt.js";

const ALLOWED_STATES = new Set(["ON", "OFF"]);
const ALLOWED_ACTUATORS = new Set(["light", "fan"]);

function validateStatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new DeviceShadowError(
      "desiredState phải là một object",
      "INVALID_STATE",
    );
  }
  const entries = Object.entries(patch);
  if (!entries.length)
    throw new DeviceShadowError("desiredState không được rỗng", "EMPTY_STATE");
  for (const [key, value] of entries) {
    if (!ALLOWED_ACTUATORS.has(key)) {
      throw new DeviceShadowError(
        `Cơ cấu chấp hành không được hỗ trợ: ${key}`,
        "INVALID_ACTUATOR",
      );
    }
    if (!ALLOWED_STATES.has(value)) {
      throw new DeviceShadowError(
        `Trạng thái không hợp lệ cho ${key}`,
        "INVALID_STATE_VALUE",
      );
    }
  }
  return Object.fromEntries(entries);
}

function normalizeReportedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new DeviceShadowError(
      "reportedState không hợp lệ",
      "INVALID_REPORTED_STATE",
    );
  }
  const result = {};
  for (const [key, value] of Object.entries(state)) {
    if (!ALLOWED_ACTUATORS.has(key) || !ALLOWED_STATES.has(value)) {
      throw new DeviceShadowError(
        `Giá trị reportedState không hợp lệ: ${key}`,
        "INVALID_REPORTED_STATE",
      );
    }
    result[key] = value;
  }
  if (!Object.keys(result).length) {
    throw new DeviceShadowError(
      "reportedState không được rỗng",
      "EMPTY_REPORTED_STATE",
    );
  }
  return result;
}

function getDifferences(desiredState, reportedState) {
  const differences = {};
  for (const key of Object.keys(desiredState)) {
    if (desiredState[key] !== reportedState[key]) {
      differences[key] = {
        desired: desiredState[key],
        reported: reportedState[key] ?? null,
      };
    }
  }
  return differences;
}

export class DeviceShadowService {
  constructor({
    repository,
    mqttPublisher,
    now = () => new Date().toISOString(),
  }) {
    if (!repository || !mqttPublisher)
      throw new TypeError("Cần repository và mqttPublisher");
    this.repository = repository;
    this.mqttPublisher = mqttPublisher;
    this.now = now;
  }

  async getShadow(deviceId) {
    const shadow = await this.repository.getShadow(deviceId);
    if (!shadow)
      throw new DeviceShadowError(
        "Không tìm thấy thiết bị",
        "DEVICE_NOT_FOUND",
      );
    const latestCommand =
      await this.repository.getLatestCommandForDevice(deviceId);
    return {
      ...shadow,
      differences: getDifferences(shadow.desiredState, shadow.reportedState),
      inSync:
        Object.keys(getDifferences(shadow.desiredState, shadow.reportedState))
          .length === 0,
      latestCommand,
    };
  }

  async setDesiredState(deviceId, statePatch, { requestedBy = null } = {}) {
    const patch = validateStatePatch(statePatch);
    const shadow = await this.repository.getShadow(deviceId);
    if (!shadow)
      throw new DeviceShadowError(
        "Không tìm thấy thiết bị",
        "DEVICE_NOT_FOUND",
      );

    const topic = buildDeviceCommandTopic(shadow.roomCode, deviceId);
    const desiredState = { ...shadow.desiredState, ...patch };
    const commandId = randomUUID();
    const createdAt = this.now();
    const command = {
      commandId,
      deviceId,
      roomCode: shadow.roomCode,
      desiredState: patch,
      requestedBy,
      status: "PENDING",
      createdAt,
      publishedAt: null,
      acknowledgedAt: null,
      error: null,
    };

    const updatedShadow = {
      ...shadow,
      desiredState,
      version: shadow.version + 1,
      updatedAt: createdAt,
      lastCommandError: null,
    };

    await this.repository.saveShadow(updatedShadow);
    await this.repository.saveCommand(command);

    const payload = {
      messageType: "command",
      commandId,
      deviceId,
      roomCode: shadow.roomCode,
      desiredState: patch,
      shadowVersion: updatedShadow.version,
      timestamp: createdAt,
    };

    try {
      await this.mqttPublisher.publishCommand(topic, payload);
      await this.repository.updateCommand(commandId, {
        status: "SENT",
        publishedAt: this.now(),
      });
    } catch (error) {
      await this.repository.updateCommand(commandId, {
        status: "PUBLISH_FAILED",
        error: error?.message ?? "Không gửi được lệnh MQTT",
      });
      await this.repository.saveShadow({
        ...updatedShadow,
        lastCommandError: "Không gửi được lệnh MQTT",
      });
      throw new DeviceShadowError(
        "Không gửi được lệnh điều khiển qua MQTT",
        "MQTT_PUBLISH_FAILED",
      );
    }

    return {
      command: await this.repository.getCommand(commandId),
      shadow: await this.getShadow(deviceId),
    };
  }

  async handleReportedState({
    deviceId,
    reportedState,
    timestamp = this.now(),
  }) {
    const normalized = normalizeReportedState(reportedState);
    const shadow = await this.repository.getShadow(deviceId);
    if (!shadow)
      throw new DeviceShadowError(
        "Không tìm thấy thiết bị",
        "DEVICE_NOT_FOUND",
      );

    const updated = await this.repository.saveShadow({
      ...shadow,
      reportedState: { ...shadow.reportedState, ...normalized },
      lastReportedAt: timestamp,
      updatedAt: this.now(),
    });

    return {
      ...updated,
      differences: getDifferences(updated.desiredState, updated.reportedState),
    };
  }

  async handleCommandAck({
    deviceId,
    commandId,
    status,
    reportedState,
    timestamp = this.now(),
    error = null,
  }) {
    if (!deviceId || !commandId || !["SUCCESS", "FAILED"].includes(status)) {
      throw new DeviceShadowError("ACK không hợp lệ", "INVALID_ACK");
    }

    const command = await this.repository.getCommand(commandId);
    if (!command || command.deviceId !== deviceId) {
      throw new DeviceShadowError(
        "ACK không khớp lệnh hoặc thiết bị",
        "ACK_COMMAND_MISMATCH",
      );
    }
    if (["ACKNOWLEDGED", "FAILED"].includes(command.status)) {
      return { command, duplicate: true };
    }

    let shadow = await this.repository.getShadow(deviceId);
    if (!shadow)
      throw new DeviceShadowError(
        "Không tìm thấy thiết bị",
        "DEVICE_NOT_FOUND",
      );

    if (reportedState !== undefined && reportedState !== null) {
      const normalized = normalizeReportedState(reportedState);
      shadow = {
        ...shadow,
        reportedState: { ...shadow.reportedState, ...normalized },
        lastReportedAt: timestamp,
        updatedAt: this.now(),
      };
      await this.repository.saveShadow(shadow);
    }

    const updatedCommand = await this.repository.updateCommand(commandId, {
      status: status === "SUCCESS" ? "ACKNOWLEDGED" : "FAILED",
      acknowledgedAt: timestamp,
      error:
        status === "FAILED" ? error || "Thiết bị thực thi lệnh thất bại" : null,
    });

    if (status === "FAILED") {
      await this.repository.saveShadow({
        ...shadow,
        lastCommandError: error || "Thiết bị thực thi lệnh thất bại",
      });
    }

    return {
      command: updatedCommand,
      shadow: await this.getShadow(deviceId),
      duplicate: false,
    };
  }
}
