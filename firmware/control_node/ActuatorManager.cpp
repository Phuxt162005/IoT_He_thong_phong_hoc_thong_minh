
#include "ActuatorManager.h"
#include <ArduinoJson.h>
#include <cstring>

ActuatorManager::ActuatorManager(
  PubSubClient& mqtt,
  NodeSessionManager& session,
  const String& deviceId,
  const String& roomId,
  uint8_t pinFan,
  uint8_t pinLight,
  bool activeLow
) : _mqtt(mqtt),
    _session(session),
    _deviceId(deviceId),
    _roomId(roomId),
    _pinFan(pinFan),
    _pinLight(pinLight),
    _activeLow(activeLow) {
  _commandTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/command";
  _ackTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/ack";
  _reportedTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/reported";
}

void ActuatorManager::writeHardware(uint8_t pin, bool on) {
  digitalWrite(pin, _activeLow ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}

void ActuatorManager::begin() {
  // Đưa GPIO về trạng thái OFF ngay khi khởi tạo.
  digitalWrite(_pinFan, _activeLow ? HIGH : LOW);
  pinMode(_pinFan, OUTPUT);
  digitalWrite(_pinFan, _activeLow ? HIGH : LOW);

  digitalWrite(_pinLight, _activeLow ? HIGH : LOW);
  pinMode(_pinLight, OUTPUT);
  digitalWrite(_pinLight, _activeLow ? HIGH : LOW);

  // Mở NVS và khôi phục version/command ID, không khôi phục trạng thái ON.
  _prefsReady = _prefs.begin("dev_act", false);

  if (_prefsReady) {
    _shadowVersion = _prefs.getUInt("shadow_ver", 1);
    _lastProcessedCommandId = _prefs.getString("last_cmd_id", "");
  } else {
    _shadowVersion = 1;
    _lastProcessedCommandId = "";
    Serial.println("[Actuator] WARNING: Khong mo duoc NVS Preferences");
  }

  // Chính sách an toàn: relay luôn OFF sau khi khởi động.
  _fanOn = false;
  _lightOn = false;
  writeHardware(_pinFan, false);
  writeHardware(_pinLight, false);

  Serial.printf(
    "[Actuator] Khoi tao relay: FAN=OFF, LIGHT=OFF, ShadowVer=%u\n",
    _shadowVersion
  );
}

bool ActuatorManager::subscribe() {
  if (!_mqtt.connected()) return false;

  bool ok = _mqtt.subscribe(_commandTopic.c_str(), 1);

  if (ok) {
    Serial.println("[Actuator] Subscribed: " + _commandTopic);
  } else {
    Serial.println("[Actuator] Subscribe that bai: " + _commandTopic);
  }

  return ok;
}

bool ActuatorManager::isCommandProcessed(const String& cmdId) {
  if (cmdId == _lastProcessedCommandId) return true;

  for (size_t i = 0; i < DEDUP_SIZE; i++) {
    if (_recentCommandIds[i] == cmdId) return true;
  }

  return false;
}

void ActuatorManager::markCommandProcessed(const String& cmdId) {
  _recentCommandIds[_dedupIndex] = cmdId;
  _dedupIndex = (_dedupIndex + 1) % DEDUP_SIZE;
}

String ActuatorManager::getFanState() const {
  return _fanOn ? "ON" : "OFF";
}

String ActuatorManager::getLightState() const {
  return _lightOn ? "ON" : "OFF";
}

uint32_t ActuatorManager::getShadowVersion() const {
  return _shadowVersion;
}

String ActuatorManager::getReportedStatusJson() const {
  return "{\"reported_state\":{\"fan\":\"" + getFanState() +
         "\",\"light\":\"" + getLightState() +
         "\"},\"shadow_version\":" + String(_shadowVersion) + "}";
}

void ActuatorManager::setFan(bool on) {
  _fanOn = on;
  writeHardware(_pinFan, on);

  if (_prefsReady) {
    _prefs.putBool("fan_on", _fanOn);
  }

  Serial.printf("[Relay] QUAT (GPIO %d) -> %s\n",
    _pinFan, on ? "BAT (ON)" : "TAT (OFF)");
}

void ActuatorManager::setLight(bool on) {
  _lightOn = on;
  writeHardware(_pinLight, on);

  if (_prefsReady) {
    _prefs.putBool("light_on", _lightOn);
  }

  Serial.printf("[Relay] DEN (GPIO %d) -> %s\n",
    _pinLight, on ? "BAT (ON)" : "TAT (OFF)");
}

bool ActuatorManager::sendAck(
  const String& commandId,
  uint32_t version,
  bool success,
  const String& errorCode
) {
  if (!_mqtt.connected()) {
    Serial.println("[Actuator] Khong the gui ACK: MQTT disconnected");
    return false;
  }

  StaticJsonDocument<512> doc;
  doc["command_id"] = commandId;
  doc["device_id"] = _deviceId;
  doc["room_id"] = _roomId;
  doc["session_id"] = _session.getSessionId();
  doc["shadow_version"] = version;
  doc["status"] = success ? "SUCCESS" : "FAILED";
  doc["timestamp"] = _session.getNowMs();

  JsonObject reported = doc.createNestedObject("reported_state");
  reported["fan"] = getFanState();
  reported["light"] = getLightState();

  if (!success && !errorCode.isEmpty()) {
    doc["error_code"] = errorCode;
  }

  String payload;
  serializeJson(doc, payload);

  bool published = _mqtt.publish(_ackTopic.c_str(), payload.c_str(), false);

  if (published) {
    Serial.printf("[Actuator] ACK %s da publish cho command %s, ver %u\n",
      success ? "SUCCESS" : "FAILED", commandId.c_str(), version);
  } else {
    Serial.printf("[Actuator] ACK publish THAT BAI cho command %s\n",
      commandId.c_str());
  }

  return published;
}

bool ActuatorManager::handleMessage(
  const char* topic,
  const uint8_t* payload,
  size_t length
) {
  if (!topic || String(topic) != _commandTopic || !payload || length == 0) {
    return false;
  }

  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, payload, length);

  if (err) {
    Serial.println("[Actuator] Loi giai ma JSON payload /command");
    return false;
  }

  // Kiểm tra kiểu dữ liệu và trường bắt buộc.
  if (!doc["command_id"].is<const char*>() ||
      !doc["device_id"].is<const char*>() ||
      !doc["room_id"].is<const char*>() ||
      !doc["session_id"].is<const char*>() ||
      !doc["shadow_version"].is<uint32_t>() ||
      !doc["expires_at"].is<uint64_t>() ||
      !doc["desired_state"].is<JsonObject>()) {
    Serial.println("[Actuator] Payload command sai cau truc hoac kieu du lieu");
    return false;
  }

  String cmdId = doc["command_id"].as<String>();
  String devId = doc["device_id"].as<String>();
  String rmId = doc["room_id"].as<String>();
  String sessId = doc["session_id"].as<String>();

  uint32_t shadowVer = doc["shadow_version"].as<uint32_t>();
  uint64_t expiresAt = doc["expires_at"].as<uint64_t>();

  JsonObject desired = doc["desired_state"].as<JsonObject>();

  if (cmdId.isEmpty() || devId.isEmpty() || rmId.isEmpty() || sessId.isEmpty() ||
      shadowVer == 0 || desired.isNull() || desired.size() == 0) {
    Serial.println("[Actuator] Command thieu gia tri bat buoc");
    return false;
  }

  if (devId != _deviceId || rmId != _roomId) {
    Serial.println("[Actuator] device_id hoac room_id khong khop");
    return false;
  }

  if (sessId != _session.getSessionId()) {
    Serial.println("[Actuator] session_id khong khop");
    return false;
  }

  // Chỉ chấp nhận fan/light và giá trị ON/OFF.
  bool hasFan = false;
  bool hasLight = false;
  bool fanTarget = false;
  bool lightTarget = false;

  for (JsonPair item : desired) {
    const char* key = item.key().c_str();

    if (!item.value().is<const char*>()) {
      Serial.println("[Actuator] Gia tri desired_state phai la chuoi");
      sendAck(cmdId, shadowVer, false, "INVALID_DESIRED_STATE");
      return true;
    }

    const char* value = item.value().as<const char*>();

    if (strcmp(key, "fan") == 0) {
      if (strcmp(value, "ON") != 0 && strcmp(value, "OFF") != 0) {
        sendAck(cmdId, shadowVer, false, "INVALID_DESIRED_STATE");
        return true;
      }
      hasFan = true;
      fanTarget = strcmp(value, "ON") == 0;
    } else if (strcmp(key, "light") == 0) {
      if (strcmp(value, "ON") != 0 && strcmp(value, "OFF") != 0) {
        sendAck(cmdId, shadowVer, false, "INVALID_DESIRED_STATE");
        return true;
      }
      hasLight = true;
      lightTarget = strcmp(value, "ON") == 0;
    } else {
      Serial.println("[Actuator] Thuoc tinh desired_state khong duoc ho tro");
      sendAck(cmdId, shadowVer, false, "INVALID_DESIRED_STATE");
      return true;
    }
  }

  if (!hasFan && !hasLight) {
    sendAck(cmdId, shadowVer, false, "INVALID_DESIRED_STATE");
    return true;
  }

  // Kiểm tra thời hạn lệnh.
  uint64_t nowMs = _session.getNowMs();
  if (nowMs > 0 && expiresAt > 0 && nowMs > expiresAt) {
    sendAck(cmdId, shadowVer, false, "COMMAND_EXPIRED");
    return true;
  }

  // Duplicate phải được xác định trước khi từ chối version cũ.
  if (isCommandProcessed(cmdId) && shadowVer == _shadowVersion) {
    Serial.println("[Actuator] Command duplicate, gui lai ACK SUCCESS");
    sendAck(cmdId, shadowVer, true);
    return true;
  }

  // Không cho phép version cũ hoặc version trùng với ID khác thực thi.
  if (shadowVer <= _shadowVersion) {
    Serial.printf(
      "[Actuator] Tu choi stale command: incoming=%u, current=%u\n",
      shadowVer, _shadowVersion
    );
    sendAck(cmdId, shadowVer, false, "STALE_SHADOW_VERSION");
    return true;
  }

  Serial.println("[Actuator] ===== NHAN DUOC LENH HOP LE =====");

  // Chỉ thay đổi relay sau khi toàn bộ desired_state đã được xác thực.
  if (hasFan) setFan(fanTarget);
  if (hasLight) setLight(lightTarget);

  _shadowVersion = shadowVer;
  _lastProcessedCommandId = cmdId;
  markCommandProcessed(cmdId);

  // Lưu version và ID để chống xử lý lại sau khi ESP32 khởi động lại.
  if (_prefsReady) {
    size_t versionBytes = _prefs.putUInt("shadow_ver", _shadowVersion);
    size_t idBytes = _prefs.putString("last_cmd_id", _lastProcessedCommandId);

    if (versionBytes == 0 || idBytes == 0) {
      Serial.println("[Actuator] WARNING: Khong luu duoc command metadata vao NVS");
    }
  }

  sendAck(cmdId, shadowVer, true);
  return true;
}
