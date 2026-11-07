#include "NodeSessionManager.h"
#include <ArduinoJson.h>
#include <esp_system.h>
#include <sys/time.h>
#include <time.h>

NodeSessionManager::NodeSessionManager(
  PubSubClient& mqtt,
  const String& deviceId,
  const String& roomId,
  const String& mqttUsername,
  const String& mqttPassword,
  const String& firmwareVersion,
  uint32_t heartbeatIntervalSeconds
) : _mqtt(mqtt),
    _deviceId(deviceId),
    _roomId(roomId),
    _mqttUsername(mqttUsername),
    _mqttPassword(mqttPassword),
    _firmwareVersion(firmwareVersion),
    _heartbeatIntervalSeconds(heartbeatIntervalSeconds) {
  _statusTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/status";
  _heartbeatTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/heartbeat";
}

bool NodeSessionManager::isValidIdentifier(const String& val) const {
  if (val.isEmpty() || val.length() > 40) return false;
  for (size_t i = 0; i < val.length(); ++i) {
    const char c = val[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) {
      return false;
    }
  }
  return true;
}

bool NodeSessionManager::begin() {
  _errorMessage = "";

  if (!isValidIdentifier(_deviceId) || !isValidIdentifier(_roomId)) {
    _errorMessage = "deviceId hoac roomId khong hop le";
    return false;
  }

  // Tăng buffer size để đảm bảo vừa các gói tin JSON lớn
  _mqtt.setBufferSize(2048);
  _mqtt.setKeepAlive(30);

  // Cấu hình đồng bộ thời gian NTP (UTC 0)
  configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");

  return true;
}

void NodeSessionManager::setOnConnectedCallback(MqttConnectedCallback callback) {
  _onConnectedCallback = callback;
}

void NodeSessionManager::setExtraStatusPayloadHook(ExtraStatusPayloadCallback hook) {
  _extraStatusHook = hook;
}

void NodeSessionManager::setHeartbeatInterval(uint32_t seconds) {
  if (seconds >= 1 && seconds <= 60) {
    _heartbeatIntervalSeconds = seconds;
  }
}

uint32_t NodeSessionManager::getHeartbeatInterval() const {
  return _heartbeatIntervalSeconds;
}

String NodeSessionManager::getSessionId() const {
  return _sessionId;
}

bool NodeSessionManager::isWifiConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

bool NodeSessionManager::isMqttConnected() const {
  return _mqtt.connected();
}

bool NodeSessionManager::isTimeSynced() const {
  if (_timeSynced) return true;
  time_t now = time(nullptr);
  if (now >= 1700000000) {
    const_cast<NodeSessionManager*>(this)->_timeSynced = true;
    return true;
  }
  return false;
}

uint64_t NodeSessionManager::getNowMs() const {
  struct timeval tv;
  if (gettimeofday(&tv, nullptr) == 0 && tv.tv_sec >= 1700000000) {
    return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
  }
  return 0;
}

String NodeSessionManager::generateSessionId() {
  char buf[36];
  snprintf(
    buf,
    sizeof(buf),
    "sess-%08lx-%08lx",
    (unsigned long)esp_random(),
    (unsigned long)millis()
  );
  return String(buf);
}

String NodeSessionManager::generateMsgId() {
  char buf[36];
  snprintf(
    buf,
    sizeof(buf),
    "hb-%08lx-%08lx",
    (unsigned long)esp_random(),
    (unsigned long)++_messageCounter
  );
  return String(buf);
}

bool NodeSessionManager::connectMqtt() {
  if (_mqtt.connected()) return true;
  if (!isWifiConnected()) {
    _errorMessage = "Wi-Fi chua ket noi";
    return false;
  }

  // 1. Sinh session_id mới cho phiên kết nối này theo chuẩn BE-09
  _sessionId = generateSessionId();

  // 2. Chuẩn bị bản tin Last Will and Testament (LWT) gắn với session_id hiện tại
  StaticJsonDocument<256> willDoc;
  willDoc["device_id"] = _deviceId;
  willDoc["room_id"] = _roomId;
  willDoc["session_id"] = _sessionId;
  willDoc["status"] = "OFFLINE";
  willDoc["reason"] = "UNEXPECTED_DISCONNECT";

  String willPayload;
  serializeJson(willDoc, willPayload);

  // 3. Thực hiện kết nối MQTT với LWT (QoS 1, retain false)
  bool success = _mqtt.connect(
    _deviceId.c_str(),
    _mqttUsername.c_str(),
    _mqttPassword.c_str(),
    _statusTopic.c_str(),
    1,     // willQoS = 1
    false, // willRetain = false
    willPayload.c_str()
  );

  if (!success) {
    _errorMessage = "MQTT connect failed (state " + String(_mqtt.state()) + ")";
    return false;
  }

  _errorMessage = "";
  _onlineStatusPublished = false;

  // 4. Gọi callback ứng dụng đăng ký (để subscribe các topic như /config, /command, /telemetry/ack, v.v.)
  if (_onConnectedCallback) {
    _onConnectedCallback(_sessionId);
  }

  // 5. Nếu thời gian đã đồng bộ, publish ngay bản tin ONLINE và heartbeat đầu tiên
  if (isTimeSynced()) {
    publishOnlineStatus();
  }

  return true;
}

bool NodeSessionManager::publishOnlineStatus() {
  if (!_mqtt.connected()) return false;

  uint64_t nowMs = getNowMs();
  if (nowMs == 0) {
    _errorMessage = "Chua dong bo thoi gian NTP, hoan gui ONLINE";
    return false;
  }

  StaticJsonDocument<512> doc;
  doc["device_id"] = _deviceId;
  doc["room_id"] = _roomId;
  doc["session_id"] = _sessionId;
  doc["timestamp"] = nowMs;
  doc["status"] = "ONLINE";

  // Nếu có hook bổ sung (cho Control Node đính kèm reported_state và shadow_version)
  if (_extraStatusHook) {
    String extraJson = _extraStatusHook(_sessionId);
    if (extraJson.length() > 0) {
      StaticJsonDocument<256> extraDoc;
      if (deserializeJson(extraDoc, extraJson) == DeserializationError::Ok) {
        if (extraDoc.containsKey("reported_state") && extraDoc.containsKey("shadow_version")) {
          doc["reported_state"] = extraDoc["reported_state"];
          doc["shadow_version"] = extraDoc["shadow_version"];
        }
      }
    }
  }

  String payload;
  serializeJson(doc, payload);

  bool ok = _mqtt.publish(_statusTopic.c_str(), payload.c_str(), false);
  if (ok) {
    _onlineStatusPublished = true;
    _errorMessage = "";
    // Gửi ngay heartbeat đầu tiên của phiên theo yêu cầu BE-09 (cần heartbeat mới để kích hoạt)
    publishHeartbeat();
  } else {
    _errorMessage = "Publish /status ONLINE that bai";
  }

  return ok;
}

bool NodeSessionManager::publishHeartbeat() {
  if (!_mqtt.connected()) return false;

  uint64_t nowMs = getNowMs();
  if (nowMs == 0) {
    _errorMessage = "Chua dong bo thoi gian NTP, hoan gui heartbeat";
    return false;
  }

  // Backend yêu cầu uptime_seconds phải tăng dần và duy nhất trong cùng session
  uint32_t currentUptime = (uint32_t)(millis() / 1000);
  if (currentUptime <= _lastUptimeSeconds) {
    currentUptime = _lastUptimeSeconds + 1;
  }
  _lastUptimeSeconds = currentUptime;

  // Lấy thông số chẩn đoán
  uint32_t freeHeap = ESP.getFreeHeap();
  int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -127;
  if (rssi > 0 || rssi < -127) rssi = -127; // clamp [-127, 0]

  StaticJsonDocument<384> doc;
  doc["msg_id"] = generateMsgId();
  doc["device_id"] = _deviceId;
  doc["room_id"] = _roomId;
  doc["session_id"] = _sessionId;
  doc["timestamp"] = nowMs;
  doc["uptime_seconds"] = currentUptime;
  doc["free_heap_bytes"] = freeHeap;
  doc["wifi_rssi_dbm"] = rssi;
  if (!_firmwareVersion.isEmpty()) {
    doc["firmware_version"] = _firmwareVersion;
  }

  String payload;
  serializeJson(doc, payload);

  bool ok = _mqtt.publish(_heartbeatTopic.c_str(), payload.c_str(), false);
  if (ok) {
    _lastHeartbeatMillis = millis();
    _errorMessage = "";
  } else {
    _errorMessage = "Publish /heartbeat that bai";
  }

  return ok;
}

void NodeSessionManager::disconnect() {
  if (_mqtt.connected()) {
    _mqtt.disconnect();
  }
  _onlineStatusPublished = false;
}

String NodeSessionManager::lastError() const {
  return _errorMessage;
}

void NodeSessionManager::loop() {
  const uint32_t now = millis();

  // 1. Kiểm tra kết nối Wi-Fi (nếu mất thì thử kết nối lại sau mỗi 5s)
  if (!isWifiConnected()) {
    _onlineStatusPublished = false;
    if (now - _lastWifiAttemptMillis >= 5000) {
      _lastWifiAttemptMillis = now;
      WiFi.reconnect();
    }
    return;
  }

  // 2. Kiểm tra trạng thái NTP
  if (!_timeSynced) {
    isTimeSynced();
  }

  // 3. Quản lý kết nối MQTT
  if (_mqtt.connected()) {
    _mqtt.loop();

    // Nếu vừa đồng bộ thời gian mà chưa gửi ONLINE status
    if (!_onlineStatusPublished && isTimeSynced()) {
      publishOnlineStatus();
    }

    // Kiểm tra chu kỳ gửi heartbeat
    if (isTimeSynced() && (now - _lastHeartbeatMillis >= _heartbeatIntervalSeconds * 1000)) {
      publishHeartbeat();
    }
  } else {
    _onlineStatusPublished = false;
    if (now - _lastMqttAttemptMillis >= 5000) {
      _lastMqttAttemptMillis = now;
      connectMqtt();
    }
  }
}

