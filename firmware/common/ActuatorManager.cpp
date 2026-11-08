#include "ActuatorManager.h"
#include <ArduinoJson.h>

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
  if (_activeLow) {
    digitalWrite(pin, on ? LOW : HIGH);
  } else {
    digitalWrite(pin, on ? HIGH : LOW);
  }
}

void ActuatorManager::begin() {
  // 1. Chống xung kích nháy relay lúc vừa cắm nguồn:
  // Ghi mức ngắt vào thanh ghi TRƯỚC VÀ NGAY SAU khi bật chế độ OUTPUT
  digitalWrite(_pinFan, _activeLow ? HIGH : LOW);
  pinMode(_pinFan, OUTPUT);
  digitalWrite(_pinFan, _activeLow ? HIGH : LOW);

  digitalWrite(_pinLight, _activeLow ? HIGH : LOW);
  pinMode(_pinLight, OUTPUT);
  digitalWrite(_pinLight, _activeLow ? HIGH : LOW);

  // 2. Mở bộ nhớ NVS Preferences để khôi phục trạng thái trước khi mất điện
  if (_prefs.begin("dev_act", false)) {
    _fanOn = _prefs.getBool("fan_on", false);
    _lightOn = _prefs.getBool("light_on", false);
    _shadowVersion = _prefs.getUInt("shadow_ver", 1);
  } else {
    _fanOn = false;
    _lightOn = false;
    _shadowVersion = 1;
  }

  // 3. Áp dụng trạng thái thực tế
  writeHardware(_pinFan, _fanOn);
  writeHardware(_pinLight, _lightOn);

  Serial.printf(
    "[Actuator] Khoi tao Relay K1 (GPIO %d - FAN: %s) va K2 (GPIO %d - LIGHT: %s), ShadowVer: %u\n",
    _pinFan, _fanOn ? "BAT" : "TAT",
    _pinLight, _lightOn ? "BAT" : "TAT",
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
  for (size_t i = 0; i < DEDUP_SIZE; i++) {
    if (_recentCommandIds[i] == cmdId) {
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
  return "{\"reported_state\":{\"fan\":\"" + getFanState() + "\",\"light\":\"" + getLightState() + "\"},\"shadow_version\":" + String(_shadowVersion) + "}";
}

void ActuatorManager::setFan(bool on) {
  _fanOn = on;
  writeHardware(_pinFan, on);
  _prefs.putBool("fan_on", _fanOn);
  Serial.printf("[Relay] QUAT (GPIO %d) -> %s\n", _pinFan, on ? "BAT (ON)" : "TAT (OFF)");
}

void ActuatorManager::setLight(bool on) {
  _lightOn = on;
  writeHardware(_pinLight, on);
  _prefs.putBool("light_on", _lightOn);
  Serial.printf("[Relay] DEN (GPIO %d) -> %s\n", _pinLight, on ? "BAT (ON)" : "TAT (OFF)");
}

void ActuatorManager::sendAck(
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

  JsonObject rep = doc.createNestedObject("reported_state");
  rep["fan"] = getFanState();
  rep["light"] = getLightState();

  if (!success && !errorCode.isEmpty()) {
    doc["error_code"] = errorCode;
  }

  String payload;
  serializeJson(doc, payload);

  _mqtt.publish(_ackTopic.c_str(), payload.c_str(), false);
  Serial.printf("[Actuator] Da gui /ack (%s) cho command %s, ver %u\n", success ? "SUCCESS" : "FAILED", commandId.c_str(), version);
}

bool ActuatorManager::handleMessage(const char* topic, const uint8_t* payload, size_t length) {
  if (!topic || String(topic) != _commandTopic || !payload || length == 0) {
    return false;
  }

  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.println("[Actuator] Loi giai ma JSON payload /command");
    return false;
  }

  const char* cmdId = doc["command_id"];
  const char* devId = doc["device_id"];
  const char* rmId = doc["room_id"];
  const char* sessId = doc["session_id"];
  uint32_t shadowVer = doc["shadow_version"] | 0;
  uint64_t expiresAt = doc["expires_at"] | 0;
  JsonObject desired = doc["desired_state"];

  if (!cmdId || !devId || !rmId || !sessId || desired.isNull()) {
    Serial.println("[Actuator] Ban tin /command thieu truong bat buoc");
    return false;
  }

  if (String(devId) != _deviceId || String(rmId) != _roomId) {
    Serial.println("[Actuator] device_id hoac room_id khong khop");
    return false;
  }

  if (String(sessId) != _session.getSessionId()) {
    Serial.printf("[Actuator] session_id (%s) khong khop phien hien tai (%s)\n", sessId, _session.getSessionId().c_str());
    return false;
  }

  uint64_t nowMs = _session.getNowMs();
  if (nowMs > 0 && expiresAt > 0 && nowMs > expiresAt) {
    Serial.println("[Actuator] Lenh da het han, tu choi");
    sendAck(cmdId, shadowVer, false, "COMMAND_EXPIRED");
    return true;
  }

  if (isCommandProcessed(cmdId)) {
    Serial.println("[Actuator] Nhan lai lenh da thuc thi (Duplicate), gui lai ACK SUCCESS.");
    sendAck(cmdId, shadowVer, true);
    return true;
  }

  Serial.println("[Actuator] ===== NHAN DUOC LENH DIEU KHIEN =====");
  if (desired.containsKey("fan")) {
    const char* fanAction = desired["fan"];
    setFan(strcmp(fanAction, "ON") == 0);
  }

  if (desired.containsKey("light")) {
    const char* lightAction = desired["light"];
    setLight(strcmp(lightAction, "ON") == 0);
  }

  _shadowVersion = shadowVer;
  _prefs.putUInt("shadow_ver", _shadowVersion);
  markCommandProcessed(cmdId);

  sendAck(cmdId, shadowVer, true);

  return true;
}
