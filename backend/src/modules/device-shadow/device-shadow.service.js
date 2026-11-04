import { DeviceShadowError } from "./device-shadow.errors.js";

const ALLOWED_STATES = new Set(["ON", "OFF"]);
const ALLOWED_ACTUATORS = new Set(["light", "fan"]);

export function validateStatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new DeviceShadowError(
      "desiredState phải là một object",
      "INVALID_STATE",
    );
  }

  const entries = Object.entries(patch);

  if (!entries.length) {
    throw new DeviceShadowError("desiredState không được rỗng", "EMPTY_STATE");
  }

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

function getDifferences(desiredState, reportedState) {
  const differences = {};

  for (const key of Object.keys(desiredState)) {
    const desired = desiredState[key];
    const reported = reportedState?.[key] ?? null;

    if (desired !== reported) {
      differences[key] = { desired, reported };
    }
  }

  return differences;
}

export class DeviceShadowService {
  constructor({ repository }) {
    if (!repository) {
      throw new TypeError("Cần device shadow repository");
    }

    this.repository = repository;
  }

  async getShadow(deviceId) {
    const shadow = await this.repository.getShadow(deviceId);

    if (!shadow) {
      throw new DeviceShadowError(
        "Không tìm thấy thiết bị",
        "DEVICE_NOT_FOUND",
      );
    }

    const differences = getDifferences(
      shadow.desiredState,
      shadow.reportedState,
    );

    const latestCommand =
      await this.repository.getLatestCommandForDevice(deviceId);

    return {
      ...shadow,
      differences,
      inSync: Object.keys(differences).length === 0,
      latestCommand,
    };
  }
}
