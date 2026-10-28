export class DeviceShadowError extends Error {
  constructor(message, code = "DEVICE_SHADOW_ERROR") {
    super(message);
    this.name = "DeviceShadowError";
    this.code = code;
  }
}
