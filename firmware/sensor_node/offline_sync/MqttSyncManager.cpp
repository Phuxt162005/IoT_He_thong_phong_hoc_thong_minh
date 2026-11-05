#include "MqttSyncManager.h"
#include <ArduinoJson.h>

MqttSyncManager::MqttSyncManager(
  PubSubClient& mqttClient,
  OfflineQueue& offlineQueue,
  const String& device,
  const String& room
) : mqtt(mqttClient), queue(offlineQueue),
    deviceId(device), roomId(room) {
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

  // Kết nối lại thì gửi lại bản ghi đầu hàng đợi.
  // Backend xử lý idempotency theo msg_id.
  lastPublishAt = 0;
  retryCount = 0;
  retryIntervalMs = 3000;
  return true;
}

bool MqttSyncManager::publishNext() {
  String record;
  if (!queue.peek(record)) {
    if (!queue.lastError().isEmpty()) errorMessage = queue.lastError();
    return false;
  }

  // PubSubClient publish() dùng QoS 0.
  // ACK STORED ở tầng ứng dụng mới quyết định xóa bản ghi.
  if (!mqtt.publish(telemetryTopic.c_str(), record.c_str(), false)) {
    errorMessage = "MQTT publish that bai";
    return false;
  }

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
  if (!pendingId) {
    errorMessage = "Telemetry trong queue thieu msg_id";
    return false;
  }

  // ACK chuẩn.
  if (ack.containsKey("msg_id")) {
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
  }
  // ACK legacy.
  else if (ack.containsKey("eventId")) {
    const char* messageType = ack["messageType"];
    const char* ackId = ack["eventId"];

    if (!messageType || String(messageType) != "telemetry_ack" ||
        !ackId || String(ackId) != String(pendingId)) {
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
  if (String(topic) != ackTopic) return;

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
  if (!validateAck(ackPayload, pendingRecord, messageId)) return;

  if (!queue.acknowledge(messageId)) {
    errorMessage = queue.lastError();
    return;
  }

  // Reset backoff sau khi xác nhận thành công.
  retryCount = 0;
  retryIntervalMs = 3000;
  lastPublishAt = 0;
  errorMessage = "";
}

void MqttSyncManager::loop() {
  if (!mqtt.connected()) return;

  const uint32_t now = millis();
  if (now - lastPublishAt < retryIntervalMs) return;

  lastPublishAt = now;

  String record;
  if (!queue.peek(record)) {
    if (!queue.lastError().isEmpty()) errorMessage = queue.lastError();
    return;
  }

  if (publishNext()) {
    ++retryCount;

    // Backoff có giới hạn; không xóa bản ghi khi chưa nhận ACK.
    if (retryIntervalMs < maxRetryIntervalMs) {
      retryIntervalMs = min(retryIntervalMs * 2, maxRetryIntervalMs);
    }
  } else {
    if (retryIntervalMs < maxRetryIntervalMs) {
      retryIntervalMs = min(retryIntervalMs * 2, maxRetryIntervalMs);
    }
  }
}