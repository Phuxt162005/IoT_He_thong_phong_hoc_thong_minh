import { DeviceShadowError } from "./device-shadow.errors.js";

const SAFE_TOPIC_PART = /^[A-Za-z0-9_-]+$/;

export function buildDeviceCommandTopic(roomCode, deviceId) {
  if (!SAFE_TOPIC_PART.test(roomCode) || !SAFE_TOPIC_PART.test(deviceId)) {
    throw new DeviceShadowError(
      "roomCode hoặc deviceId không hợp lệ",
      "INVALID_TOPIC",
    );
  }
  return `smartclassroom/room/${roomCode}/device/${deviceId}/command`;
}

export class DeviceShadowMqttPublisher {
  constructor(mqttClient) {
    if (!mqttClient || typeof mqttClient.publish !== "function") {
      throw new TypeError("mqttClient phải cung cấp hàm publish()");
    }
    this.mqttClient = mqttClient;
  }

  publishCommand(topic, payload) {
    return new Promise((resolve, reject) => {
      this.mqttClient.publish(
        topic,
        JSON.stringify(payload),
        { qos: 1, retain: false },
        (error) => {
          if (error) return reject(error);
          resolve();
        },
      );
    });
  }
}
