#include "MqttSyncManager.h"
#include <ArduinoJson.h>

MqttSyncManager::MqttSyncManager(
  PubSubClient& mqttClient,
  OfflineQueue& offlineQueue,
  const String& device,
  const String& room
) : mqtt(mqttClient),
    queue(offlineQueue),
    deviceId(device),
    roomId(room) {
  telemetryTopic = "smartclassroom/room/" + roomId +
                   "/device/" + deviceId + "/telemetry";
  ackTopic = telemetryTopic + "/ack";
}

bool MqttSyncManager::begin() {
  errorMessage = "";

  if (deviceId.isEmpty() || roomId.isEmpty()) {
    errorMessage = "Thieu deviceId hoac roomId";
    return false;
  }

  if (!queue.begin()) {
    errorMessage = queue.lastError();
    return false;
  }

  return true;
}

String MqttSyncManager::lastError() const {
  return errorMessage;
}

size_t MqttSyncManager::queuedCount() {
  return queue.count();
}

bool MqttSyncManager::enqueueSample(const TelemetrySample& sample) {
  errorMessage = "";

  String payload;
  if (!TelemetryMessage::build(deviceId, roomId, sample, payload)) {
    errorMessage = "Du lieu telemetry khong hop le";
    return false;
  }

  if (!queue.enqueue(payload)) {
    errorMessage = queue.lastError();
    return false;
  }

  return true;
}

bool MqttSyncManager::onMqttConnected() {
  if (!mqtt.connected()) {
    errorMessage = "MQTT chua ket noi";
    return false;
  }

  if (!mqtt.subscribe(ackTopic.c_str(), 1)) {
    errorMessage = "Subscribe telemetry ACK that bai";
    return false;
  }

  // Mỗi lần kết nối lại, gửi lại bản ghi chưa được ACK.
  // Backend chống trùng bằng msg_id.
  awaitingAck = false;
  retryCount = 0;
  retryIntervalMs = 3000;
  lastPublishAt = 0;

  return true;
}

bool MqttSyncManager::publishNext() {
  String record;

  if (!queue.peek(record)) {
    if (!queue.lastError().isEmpty()) {
      errorMessage = queue.lastError();
    }
    return false;
  }

  // PubSubClient publish QoS 0.
  // Chỉ ACK STORED của backend mới được phép xóa record.
  if (!mqtt.publish(telemetryTopic.c_str(), record.c_str(), false)) {
    errorMessage = "MQTT publish that bai";
    return false;
  }

  awaitingAck = true;
  lastPublishAt = millis();
  errorMessage = "";
  return true;
}

bool MqttSyncManager::validateAck(
  const String& payload,
  const String& pendingRecord,
  String& messageId
) {
  StaticJsonDocument<512> ack;
  StaticJsonDocument<2048> pending;

  if (deserializeJson(ack, payload) ||
      deserializeJson(pending, pendingRecord)) {
    errorMessage = "ACK hoac telemetry JSON khong hop le";
    return false;
  }

  const char* status = ack["status"];
  if (!status || String(status) != "STORED") {
    errorMessage = "ACK khong co trang thai STORED";
    return false;
  }

  const char* pendingId = pending["msg_id"];
  if (!pendingId) pendingId = pending["eventId"];

  if (!pendingId || !*pendingId) {
    errorMessage = "Telemetry trong queue thieu msg_id";
    return false;
  }

  if (ack.containsKey("msg_id")) {
    // ACK theo payload chuẩn.
    const char* ackId = ack["msg_id"];
    const char* ackDevice = ack["device_id"];
    const char* ackRoom = ack["room_id"];

    if (!ackId || !ackDevice || !ackRoom ||
        String(ackId) != String(pendingId) ||
        String(ackDevice) != deviceId ||
        String(ackRoom) != roomId) {
      errorMessage = "ACK chuan khong khop telemetry";
      return false;
    }
  } else if (ack.containsKey("eventId")) {
    // ACK theo payload legacy.
    const char* messageType = ack["messageType"];
    const char* ackId = ack["eventId"];

    if (!messageType ||
        String(messageType) != "telemetry_ack" ||
        !ackId ||
        String(ackId) != String(pendingId)) {
      errorMessage = "ACK legacy khong khop telemetry";
      return false;
    }
  } else {
    errorMessage = "ACK thieu msg_id/eventId";
    return false;
  }

  messageId = String(pendingId);
  return true;
}

void MqttSyncManager::handleMessage(
  char* topic,
  byte* payload,
  unsigned int length
) {
  if (!topic || String(topic) != ackTopic) return;

  String ackPayload;
  ackPayload.reserve(length + 1);

  for (unsigned int i = 0; i < length; ++i) {
    ackPayload += (char)payload[i];
  }

  String pendingRecord;
  if (!queue.peek(pendingRecord)) {
    errorMessage = "Nhan ACK nhung queue rong";
    return;
  }

  String messageId;
  if (!validateAck(ackPayload, pendingRecord, messageId)) {
    return;
  }

  if (!queue.acknowledge(messageId)) {
    errorMessage = queue.lastError();
    return;
  }

  awaitingAck = false;
  retryCount = 0;
  retryIntervalMs = 3000;
  lastPublishAt = 0;
  errorMessage = "";
}

void MqttSyncManager::loop() {
  if (!mqtt.connected()) {
    awaitingAck = false;
    return;
  }

  const uint32_t now = millis();

  if (awaitingAck) {
    if (now - lastPublishAt < ackTimeoutMs) return;

    // Quá thời gian chờ ACK: giữ nguyên bản ghi và retry.
    awaitingAck = false;
    ++retryCount;

    if (retryIntervalMs < maxRetryIntervalMs) {
      retryIntervalMs = min(
        retryIntervalMs * 2,
        maxRetryIntervalMs
      );
    }
  }

  if (now - lastPublishAt < retryIntervalMs) return;

  publishNext();
}