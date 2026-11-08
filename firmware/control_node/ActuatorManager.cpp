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

  _commandTopic = "smartclassroom/room/" + _roomId +
                  "/device/" + _deviceId + "/command";

  _ackTopic = "smartclassroom/room/" + _roomId +
              "/device/" + _deviceId + "/ack";

  _reportedTopic = "smartclassroom/room/" + _roomId +
                   "/device/" + _deviceId + "/reported";
}

void ActuatorManager::writeHardware(uint8_t pin, bool on) {
  digitalWrite(
    pin,
    _activeLow ? (on ? LOW : HIGH) : (on ? HIGH : LOW)
  );
}

void ActuatorManager::forceAllOff() {
  _fanOn = false;
  _lightOn = false;

  writeHardware(_pinFan, false);
  writeHardware(_pinLight, false);
}

void ActuatorManager::begin() {
  // Đưa relay về OFF ngay khi khởi động.
  digitalWrite(_pinFan, _activeLow ? HIGH : LOW);
  pinMode(_pinFan, OUTPUT);
  writeHardware(_pinFan, false);

  digitalWrite(_pinLight, _activeLow ? HIGH : LOW);
  pinMode(_pinLight, OUTPUT);
  writeHardware(_pinLight, false);

  forceAllOff();

  // Mở NVS.
  _prefsReady = _prefs.begin("dev_act", false);

  if (!_prefsReady) {
    _storageFault = true;

    Serial.println(
      "[Actuator] ERROR: Khong mo duoc NVS. Khoa dieu khien relay."
    );

    return;
  }

  // Ưu tiên đọc bản ghi metadata mới.
  String metadata = _prefs.getString("cmd_meta", "");

  if (!metadata.isEmpty()) {
    StaticJsonDocument<192> doc;

    DeserializationError err = deserializeJson(doc, metadata);

    if (err ||
        !doc["shadow_version"].is<uint32_t>() ||
        !doc["command_id"].is<const char*>()) {

      _storageFault = true;

      Serial.println(
        "[Actuator] ERROR: Metadata NVS khong hop le."
      );

      return;
    }

    _shadowVersion = doc["shadow_version"].as<uint32_t>();
    _lastProcessedCommandId = doc["command_id"].as<String>();

    if (_shadowVersion == 0 || _shadowVersion > 2147483647UL) {
      _storageFault = true;

      Serial.println(
        "[Actuator] ERROR: Shadow version trong NVS khong hop le."
      );

      return;
    }
  } else {
    // Tương thích dữ liệu từ phiên bản firmware cũ.
    _shadowVersion = _prefs.getUInt("shadow_ver", 1);
    _lastProcessedCommandId = _prefs.getString("last_cmd_id", "");

    if (_shadowVersion == 0 || _shadowVersion > 2147483647UL) {
      _storageFault = true;

      Serial.println(
        "[Actuator] ERROR: Shadow version cu khong hop le."
      );

      return;
    }
  }

  // Không khôi phục trạng thái ON từ NVS.
  forceAllOff();

  Serial.printf(
    "[Actuator] Khoi tao: FAN=OFF, LIGHT=OFF, ShadowVer=%u\n",
    _shadowVersion
  );
}

bool ActuatorManager::subscribe() {
  if (!_mqtt.connected() || _storageFault) {
    return false;
  }

  bool ok = _mqtt.subscribe(_commandTopic.c_str(), 1);

  if (ok) {
    Serial.println("[Actuator] Subscribed: " + _commandTopic);
  } else {
    Serial.println("[Actuator] Subscribe that bai.");
  }

  return ok;
}

bool ActuatorManager::isCommandProcessed(const String& cmdId) {
  if (!cmdId.isEmpty() && cmdId == _lastProcessedCommandId) {
    return true;
  }

  for (size_t i = 0; i < DEDUP_SIZE; i++) {
    if (_recentCommandIds[i] == cmdId && !cmdId.isEmpty()) {
      return true;
    }
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

  Serial.printf(
    "[Relay] QUAT (GPIO %d) -> %s\n",
    _pinFan,
    on ? "BAT (ON)" : "TAT (OFF)"
  );
}

void ActuatorManager::setLight(bool on) {
  _lightOn = on;
  writeHardware(_pinLight, on);

  Serial.printf(
    "[Relay] DEN (GPIO %d) -> %s\n",
    _pinLight,
    on ? "BAT (ON)" : "TAT (OFF)"
  );
}

// Lưu version và command ID chung trong một khóa NVS.
bool ActuatorManager::saveCommandMetadata(
  uint32_t version,
  const String& commandId
) {
  if (!_prefsReady || commandId.isEmpty()) {
    return false;
  }

  StaticJsonDocument<192> doc;

  doc["shadow_version"] = version;
  doc["command_id"] = commandId;

  String metadata;

  if (serializeJson(doc, metadata) == 0) {
    return false;
  }

  size_t written = _prefs.putString("cmd_meta", metadata);

  if (written != metadata.length()) {
    return false;
  }

  // Đọc lại để xác minh dữ liệu đã được ghi.
  String saved = _prefs.getString("cmd_meta", "");

  return saved == metadata;
}

bool ActuatorManager::publishAck(const String& payload) {
  if (!_mqtt.connected()) {
    return false;
  }

  return _mqtt.publish(
    _ackTopic.c_str(),
    payload.c_str(),
    false
  );
}

bool ActuatorManager::sendAck(
  const String& commandId,
  uint32_t version,
  bool success,
  const String& errorCode
) {
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

  if (serializeJson(doc, payload) == 0) {
    Serial.println("[Actuator] Loi tao ACK JSON.");
    return false;
  }

  bool published = publishAck(payload);

  if (published) {
    Serial.printf(
      "[Actuator] ACK %s: command=%s, version=%u\n",
      success ? "SUCCESS" : "FAILED",
      commandId.c_str(),
      version
    );

    _pendingAckPayload = "";
    return true;
  }

  // Giữ ACK để thử gửi lại trong loop().
  _pendingAckPayload = payload;
  _lastAckAttemptMs = millis();

  Serial.println(
    "[Actuator] ACK chua gui duoc. Se thu lai."
  );

  return false;
}

void ActuatorManager::loop() {
  if (_pendingAckPayload.isEmpty() || !_mqtt.connected()) {
    return;
  }

  uint32_t now = millis();

  if (now - _lastAckAttemptMs < 2000) {
    return;
  }

  _lastAckAttemptMs = now;

  if (publishAck(_pendingAckPayload)) {
    Serial.println("[Actuator] Da gui lai ACK thanh cong.");
    _pendingAckPayload = "";
  }
}

bool ActuatorManager::handleMessage(
  const char* topic,
  const uint8_t* payload,
  size_t length
) {
  if (!topic ||
      String(topic) != _commandTopic ||
      !payload ||
      length == 0) {
    return false;
  }

  if (_storageFault || !_prefsReady) {
    Serial.println(
      "[Actuator] Tu choi command: NVS khong san sang."
    );

    return true;
  }

  StaticJsonDocument<768> doc;

  DeserializationError err = deserializeJson(doc, payload, length);

  if (err) {
    Serial.println("[Actuator] JSON command khong hop le.");
    return true;
  }

  // Kiểm tra trường bắt buộc.
  if (!doc["command_id"].is<const char*>() ||
      !doc["device_id"].is<const char*>() ||
      !doc["room_id"].is<const char*>() ||
      !doc["session_id"].is<const char*>() ||
      !doc["shadow_version"].is<uint32_t>() ||
      !doc["expires_at"].is<uint64_t>() ||
      !doc["desired_state"].is<JsonObject>()) {

    Serial.println("[Actuator] Command sai cau truc.");
    return true;
  }

  String cmdId = doc["command_id"].as<String>();
  String devId = doc["device_id"].as<String>();
  String rmId = doc["room_id"].as<String>();
  String sessId = doc["session_id"].as<String>();

  uint32_t version = doc["shadow_version"].as<uint32_t>();
  uint64_t expiresAt = doc["expires_at"].as<uint64_t>();

  JsonObject desired = doc["desired_state"].as<JsonObject>();

  if (cmdId.isEmpty() ||
      devId.isEmpty() ||
      rmId.isEmpty() ||
      sessId.isEmpty() ||
      version == 0 ||
      version > 2147483647UL ||
      expiresAt == 0 ||
      desired.isNull() ||
      desired.size() == 0) {

    Serial.println("[Actuator] Command thieu hoac sai gia tri.");
    return true;
  }

  if (devId != _deviceId || rmId != _roomId) {
    Serial.println("[Actuator] Sai device_id hoac room_id.");
    return true;
  }

  if (sessId != _session.getSessionId()) {
    Serial.println("[Actuator] Sai session_id.");
    return true;
  }

  // Kiểm tra toàn bộ desired_state trước khi điều khiển relay.
  bool hasFan = false;
  bool hasLight = false;

  bool fanTarget = false;
  bool lightTarget = false;

  for (JsonPair item : desired) {
    const char* key = item.key().c_str();

    if (!item.value().is<const char*>()) {
      sendAck(cmdId, version, false, "INVALID_DESIRED_STATE");
      return true;
    }

    const char* value = item.value().as<const char*>();

    if (strcmp(key, "fan") == 0) {
      if (strcmp(value, "ON") != 0 &&
          strcmp(value, "OFF") != 0) {

        sendAck(cmdId, version, false, "INVALID_DESIRED_STATE");
        return true;
      }

      hasFan = true;
      fanTarget = strcmp(value, "ON") == 0;

    } else if (strcmp(key, "light") == 0) {
      if (strcmp(value, "ON") != 0 &&
          strcmp(value, "OFF") != 0) {

        sendAck(cmdId, version, false, "INVALID_DESIRED_STATE");
        return true;
      }

      hasLight = true;
      lightTarget = strcmp(value, "ON") == 0;

    } else {
      sendAck(cmdId, version, false, "INVALID_DESIRED_STATE");
      return true;
    }
  }

  if (!hasFan && !hasLight) {
    sendAck(cmdId, version, false, "INVALID_DESIRED_STATE");
    return true;
  }

  // Không thực thi nếu chưa đồng bộ thời gian.
  uint64_t nowMs = _session.getNowMs();

  if (nowMs == 0) {
    Serial.println(
      "[Actuator] Tu choi command: NTP chua dong bo."
    );

    sendAck(cmdId, version, false, "TIME_NOT_SYNCED");
    return true;
  }

  if (nowMs > expiresAt) {
    sendAck(cmdId, version, false, "COMMAND_EXPIRED");
    return true;
  }

  // Xử lý duplicate.
  if (isCommandProcessed(cmdId)) {
    if (version != _shadowVersion) {
      sendAck(cmdId, version, false, "STALE_SHADOW_VERSION");
      return true;
    }

    // Sau reboot relay mặc định OFF.
    // Nếu duplicate yêu cầu ON thì áp dụng lại trạng thái mong muốn.
    if (hasFan) setFan(fanTarget);
    if (hasLight) setLight(lightTarget);

    sendAck(cmdId, version, true);
    return true;
  }

  // Từ chối version cũ hoặc version trùng nhưng ID khác.
  if (version <= _shadowVersion) {
    sendAck(cmdId, version, false, "STALE_SHADOW_VERSION");
    return true;
  }

  Serial.println(
    "[Actuator] ===== COMMAND HOP LE ====="
  );

  // Thực thi relay.
  if (hasFan) setFan(fanTarget);
  if (hasLight) setLight(lightTarget);

  // Lưu metadata sau khi điều khiển.
  if (!saveCommandMetadata(version, cmdId)) {
    Serial.println(
      "[Actuator] ERROR: Khong luu duoc metadata. Tat relay."
    );

    forceAllOff();
    _storageFault = true;

    sendAck(
      cmdId,
      _shadowVersion,
      false,
      "PERSISTENCE_FAILURE"
    );

    return true;
  }

  // Chỉ cập nhật version trong RAM sau khi NVS xác nhận.
  _shadowVersion = version;
  _lastProcessedCommandId = cmdId;

  markCommandProcessed(cmdId);

  sendAck(cmdId, version, true);

  return true;
}