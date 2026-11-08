#include "MqttSyncManager.h"
#include <ArduinoJson.h>
#include <stdint.h>

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

bool MqttSyncManager::isValidIdentifier(const String& value) const {
  if (value.isEmpty() || value.length() > 40) return false;

  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];

    if (!((c >= 'A' && c <= 'Z') ||
          (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') ||
          c == '_' || c == '-')) {
      return false;
    }
  }

  return true;
}

bool MqttSyncManager::isTimeReached(
  uint32_t now,
  uint32_t target
) const {
  return (int32_t)(now - target) >= 0;
}

bool MqttSyncManager::begin() {
  errorMessage = "";

  if (!isValidIdentifier(deviceId) ||
      !isValidIdentifier(roomId)) {
    errorMessage = "deviceId hoac roomId khong hop le";
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

bool MqttSyncManager::enqueueSample(
  const TelemetrySample& sample
) {
  errorMessage = "";

  String payload;

  if (!TelemetryMessage::build(
        deviceId,
        roomId,
        sample,
        payload
      )) {
    errorMessage = "Du lieu telemetry khong hop le";
    return false;
  }

  if (!queue.enqueue(payload)) {
    errorMessage = queue.lastError();
    return false;
  }

  return true;
}

bool MqttSyncManager::subscribeAck() {
  if (!mqtt.connected()) {
    errorMessage = "MQTT chua ket noi";
    return false;
  }

  lastSubscribeAttemptAt = millis();

  if (!mqtt.subscribe(ackTopic.c_str(), 1)) {
    ackSubscribed = false;
    errorMessage = "Subscribe telemetry ACK that bai";
    return false;
  }

  ackSubscribed = true;
  errorMessage = "";

  return true;
}

bool MqttSyncManager::onMqttConnected() {
  if (!mqtt.connected()) {
    errorMessage = "MQTT chua ket noi";
    return false;
  }

  awaitingAck = false;
  ackSubscribed = false;
  retryScheduled = false;

  retryCount = 0;
  retryIntervalMs = 3000;

  nextPublishAt = millis();
  lastPublishAt = 0;
  lastSubscribeAttemptAt = 0;

  return subscribeAck();
}

void MqttSyncManager::scheduleRetry(uint32_t now) {
  if (retryCount < UINT32_MAX) {
    ++retryCount;
  }

  nextPublishAt = now + retryIntervalMs;
  retryScheduled = true;

  if (retryIntervalMs < maxRetryIntervalMs) {
    if (retryIntervalMs > maxRetryIntervalMs / 2) {
      retryIntervalMs = maxRetryIntervalMs;
    } else {
      retryIntervalMs *= 2;
    }
  }
}

bool MqttSyncManager::publishNext() {
  String record;

    if (!queue.peek(record)) {
        if (!queue.lastError().isEmpty()) {
            errorMessage = queue.lastError();
            scheduleRetry(millis());
        } else {
            // Queue rỗng: kiểm tra lại sau một khoảng ngắn.
            nextPublishAt = millis() + queuePollIntervalMs;
            retryScheduled = true;
            errorMessage = "";
        }
        return false;
    }

  const uint32_t now = millis();

  if (!mqtt.publish(
        telemetryTopic.c_str(),
        record.c_str(),
        false
      )) {
    errorMessage = "MQTT publish that bai";
    awaitingAck = false;
    scheduleRetry(now);
    return false;
  }

  awaitingAck = true;
  lastPublishAt = now;
  retryScheduled = false;
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
      deserializeJson(pending, pendingRecord) ||
      !ack.is<JsonObject>() ||
      !pending.is<JsonObject>()) {
    errorMessage = "ACK hoac telemetry JSON khong hop le";
    return false;
  }

  if (!ack["status"].is<const char*>() ||
      strcmp(ack["status"].as<const char*>(), "STORED") != 0) {
    errorMessage = "ACK khong co trang thai STORED hop le";
    return false;
  }

  const bool pendingCanonical = pending.containsKey("msg_id");
  const bool ackCanonical = ack.containsKey("msg_id");
  const bool ackLegacy = ack.containsKey("eventId");

  if (ackCanonical == ackLegacy) {
    errorMessage = "ACK thieu hoac trung dinh dang";
    return false;
  }

  const char* pendingId = pendingCanonical
    ? pending["msg_id"].as<const char*>()
    : pending["eventId"].as<const char*>();

  if (!pendingId || !*pendingId) {
    errorMessage = "Telemetry trong queue thieu ID";
    return false;
  }

  if (pendingCanonical) {
    if (!ackCanonical || ack.size() != 6 ||
        !ack["msg_id"].is<const char*>() ||
        !ack["device_id"].is<const char*>() ||
        !ack["room_id"].is<const char*>() ||
        !ack["status"].is<const char*>() ||
        !ack["duplicate"].is<bool>() ||
        !ack["timestamp"].is<uint64_t>()) {
      errorMessage = "ACK chuan sai cau truc";
      return false;
    }

    if (strcmp(ack["msg_id"].as<const char*>(), pendingId) != 0 ||
        strcmp(ack["device_id"].as<const char*>(), deviceId.c_str()) != 0 ||
        strcmp(ack["room_id"].as<const char*>(), roomId.c_str()) != 0) {
      errorMessage = "ACK chuan khong khop telemetry";
      return false;
    }

  } else {
    if (!ackLegacy || ack.size() != 5 ||
        !ack["messageType"].is<const char*>() ||
        !ack["eventId"].is<const char*>() ||
        !ack["duplicate"].is<bool>() ||
        !ack["timestamp"].is<const char*>()) {
      errorMessage = "ACK legacy sai cau truc";
      return false;
    }

    if (strcmp(ack["messageType"].as<const char*>(),
               "telemetry_ack") != 0 ||
        strcmp(ack["eventId"].as<const char*>(), pendingId) != 0) {
      errorMessage = "ACK legacy khong khop telemetry";
      return false;
    }
  }

  messageId = String(pendingId);
  errorMessage = "";
  return true;
}


void MqttSyncManager::handleMessage(
  char* topic,
  byte* payload,
  unsigned int length
) {
  if (!topic || !payload || length == 0) return;
  if (String(topic) != ackTopic) return;

  String ackPayload;
  ackPayload.reserve(length + 1);

  for (unsigned int i = 0; i < length; ++i) {
    ackPayload += (char)payload[i];
  }

  String pendingRecord;

  if (!queue.peek(pendingRecord)) {
    if (!queue.lastError().isEmpty()) {
      errorMessage = queue.lastError();
    } else {
      errorMessage = "Nhan ACK nhung queue rong";
    }
    return;
  }

  String messageId;

  if (!validateAck(
        ackPayload,
        pendingRecord,
        messageId
      )) {
    return;
  }

  // Chỉ xóa bản ghi đầu tiên sau ACK STORED hợp lệ.
  if (!queue.acknowledge(messageId)) {
    errorMessage = queue.lastError();
    return;
  }

  awaitingAck = false;
  retryScheduled = false;

  retryCount = 0;
  retryIntervalMs = 3000;

  // Cho phép gửi bản ghi kế tiếp ngay ở vòng loop sau.
  nextPublishAt = millis();

  errorMessage = "";
}

void MqttSyncManager::loop() {
  if (!mqtt.connected()) {
    awaitingAck = false;
    ackSubscribed = false;
    retryScheduled = false;
    return;
  }

  const uint32_t now = millis();

  // Thử subscribe lại nếu lần đăng ký ACK trước thất bại.
  if (!ackSubscribed &&
      now - lastSubscribeAttemptAt >= subscribeRetryIntervalMs) {
    subscribeAck();
  }

  if (!ackSubscribed) return;

  // Đang chờ ACK từ backend.
  if (awaitingAck) {
    if (now - lastPublishAt < ackTimeoutMs) {
      return;
    }

    // Timeout: giữ nguyên bản ghi, lên lịch gửi lại.
    awaitingAck = false;
    errorMessage = "Cho ACK qua thoi gian";

    scheduleRetry(now);
    return;
  }

  // Chưa đến thời điểm gửi tiếp theo.
  if (retryScheduled &&
      !isTimeReached(now, nextPublishAt)) {
    return;
  }

  publishNext();
}