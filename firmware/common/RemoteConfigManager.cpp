#include "RemoteConfigManager.h"
#include <ArduinoJson.h>

RemoteConfigManager::RemoteConfigManager(
  PubSubClient& mqtt,
  NodeSessionManager& sessionManager,
  const String& deviceId,
  const String& roomId,
  bool isSensorNode,
  uint32_t defaultSampleInterval,
  uint32_t defaultHeartbeatInterval
) : _mqtt(mqtt),
    _session(sessionManager),
    _deviceId(deviceId),
    _roomId(roomId),
    _isSensorNode(isSensorNode),
    _sampleInterval(defaultSampleInterval),
    _heartbeatInterval(defaultHeartbeatInterval) {
  _configTopic = "smartclassroom/room/" + _roomId + "/device/" + _deviceId + "/config";
  _ackTopic = _configTopic + "/ack";
}

bool RemoteConfigManager::begin() {
  // Mở namespace "dev_cfg" trong bộ nhớ Flash NVS của ESP32
  if (!_prefs.begin("dev_cfg", false)) {
    Serial.println("[Config] Canh bao: Khong the mo NVS Preferences, su dung cau hinh mac dinh.");
    return false;
  }

  // Đọc cấu hình đã lưu trước đó (nếu có)
  if (_isSensorNode) {
    _sampleInterval = _prefs.getUInt("sample_int", _sampleInterval);
  }
  _heartbeatInterval = _prefs.getUInt("hb_int", _heartbeatInterval);
  _appliedVersion = _prefs.getUInt("app_ver", 0);
  _lastConfigId = _prefs.getString("last_cfg", "");

  // Áp dụng chu kỳ heartbeat đã lưu vào NodeSessionManager
  _session.setHeartbeatInterval(_heartbeatInterval);

  Serial.printf(
    "[Config] Khoi tao thanh cong: Ver=%u, Heartbeat=%us%s\n",
    _appliedVersion,
    _heartbeatInterval,
    _isSensorNode ? (", Sample=" + String(_sampleInterval) + "s").c_str() : ""
  );

  return true;
}

bool RemoteConfigManager::subscribe() {
  if (!_mqtt.connected()) return false;
  bool ok = _mqtt.subscribe(_configTopic.c_str(), 1);
  if (ok) {
    Serial.println("[Config] Subscribed: " + _configTopic);
  } else {
    Serial.println("[Config] Subscribe that bai: " + _configTopic);
  }
  return ok;
}

void RemoteConfigManager::sendAck(
  const String& configId,
  uint32_t version,
  bool success,
  const String& errorCode,
  const String& appliedSettingsJson
) {
  StaticJsonDocument<512> doc;
  doc["config_id"] = configId;
  doc["device_id"] = _deviceId;
  doc["room_id"] = _roomId;
  doc["session_id"] = _session.getSessionId();
  doc["version"] = version;
  doc["status"] = success ? "SUCCESS" : "FAILED";

  uint64_t nowMs = _session.getNowMs();
  doc["timestamp"] = nowMs > 0 ? nowMs : (uint64_t)millis();

  if (success && !appliedSettingsJson.isEmpty()) {
    StaticJsonDocument<256> settingsDoc;
    if (deserializeJson(settingsDoc, appliedSettingsJson) == DeserializationError::Ok) {
      doc["applied_settings"] = settingsDoc.as<JsonObject>();
    }
  } else if (!success) {
    doc["error_code"] = errorCode.isEmpty() ? "CONFIG_ERROR" : errorCode;
  }

  String payload;
  serializeJson(doc, payload);

  _mqtt.publish(_ackTopic.c_str(), payload.c_str(), false);
  Serial.printf("[Config] Da gui ACK (%s) cho config_id %s, ver %u\n", success ? "SUCCESS" : "FAILED", configId.c_str(), version);
}

bool RemoteConfigManager::handleMessage(const char* topic, const uint8_t* payload, size_t length) {
  if (!topic || String(topic) != _configTopic || !payload || length == 0) {
    return false;
  }

  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.println("[Config] Loi giai ma JSON payload");
    return false;
  }

  const char* configId = doc["config_id"];
  const char* devId = doc["device_id"];
  const char* rmId = doc["room_id"];
  const char* sessId = doc["session_id"];
  uint32_t version = doc["version"] | 0;
  uint64_t expiresAt = doc["expires_at"] | 0;
  JsonObject settings = doc["settings"];

  if (!configId || !devId || !rmId || !sessId || version == 0 || settings.isNull()) {
    Serial.println("[Config] Ban tin thieu truong bat buoc");
    return false;
  }

  // 1. Kiểm tra định danh thiết bị và phòng
  if (String(devId) != _deviceId || String(rmId) != _roomId) {
    Serial.println("[Config] device_id hoac room_id khong khop");
    return false;
  }

  // 2. Kiểm tra phiên kết nối hiện tại
  if (String(sessId) != _session.getSessionId()) {
    Serial.printf("[Config] session_id (%s) khong khop phien hien tai (%s)\n", sessId, _session.getSessionId().c_str());
    return false;
  }

  // 3. Kiểm tra hạn thực thi (expires_at)
  uint64_t nowMs = _session.getNowMs();
  if (nowMs > 0 && expiresAt > 0 && nowMs > expiresAt) {
    Serial.println("[Config] Cau hinh da het han, tu choi");
    sendAck(configId, version, false, "CONFIG_TIMEOUT");
    return true;
  }

  // 4. Chống thực thi lặp (Deduplication) theo chuẩn Backend:
  // Nếu config_id hoặc version đã được xử lý trước đó, gửi lại ACK SUCCESS mà không ghi lại Flash
  if (String(configId) == _lastConfigId || version <= _appliedVersion) {
    Serial.println("[Config] Nhan lai cau hinh da xu ly, gui lai ACK khong ghi de Flash.");
    String currentSettingsJson;
    StaticJsonDocument<256> curDoc;
    if (_isSensorNode) {
      curDoc["sample_interval_seconds"] = _sampleInterval;
    }
    curDoc["heartbeat_interval_seconds"] = _heartbeatInterval;
    serializeJson(curDoc, currentSettingsJson);
    sendAck(configId, version, true, "", currentSettingsJson);
    return true;
  }

  // 5. Kiểm tra tính hợp lệ của các thông số
  bool valid = true;
  String errorCode = "INVALID_SETTINGS";

  if (settings.containsKey("heartbeat_interval_seconds")) {
    int hb = settings["heartbeat_interval_seconds"];
    if (hb < 1 || hb > 60) {
      valid = false;
      errorCode = "INVALID_HEARTBEAT_INTERVAL";
    }
  }

  if (settings.containsKey("sample_interval_seconds")) {
    if (!_isSensorNode) {
      // Control Node không hỗ trợ sample_interval
      valid = false;
      errorCode = "UNSUPPORTED_SETTING";
    } else {
      int sp = settings["sample_interval_seconds"];
      if (sp < 1 || sp > 300) {
        valid = false;
        errorCode = "INVALID_SAMPLE_INTERVAL";
      }
    }
  }

  if (!valid) {
    Serial.println("[Config] Thong so khong hop le: " + errorCode);
    sendAck(configId, version, false, errorCode);
    return true;
  }

  // 6. Áp dụng cấu hình mới và lưu vào NVS (Preferences)
  if (settings.containsKey("heartbeat_interval_seconds")) {
    _heartbeatInterval = settings["heartbeat_interval_seconds"];
    _prefs.putUInt("hb_int", _heartbeatInterval);
    _session.setHeartbeatInterval(_heartbeatInterval);
  }

  if (_isSensorNode && settings.containsKey("sample_interval_seconds")) {
    _sampleInterval = settings["sample_interval_seconds"];
    _prefs.putUInt("sample_int", _sampleInterval);
  }

  _appliedVersion = version;
  _lastConfigId = String(configId);
  _prefs.putUInt("app_ver", _appliedVersion);
  _prefs.putString("last_cfg", _lastConfigId);

  Serial.printf(
    "[Config] Da ap dung cau hinh moi: Ver=%u, Heartbeat=%us%s\n",
    _appliedVersion,
    _heartbeatInterval,
    _isSensorNode ? (", Sample=" + String(_sampleInterval) + "s").c_str() : ""
  );

  // Kích hoạt callback thông báo ứng dụng chính
  if (_onChanged) {
    _onChanged(_sampleInterval, _heartbeatInterval);
  }

  // 7. Gửi ACK SUCCESS kèm applied_settings khớp với cấu hình vừa nhận
  String appliedSettingsJson;
  serializeJson(settings, appliedSettingsJson);
  sendAck(configId, version, true, "", appliedSettingsJson);

  return true;
}

void RemoteConfigManager::setOnConfigChangedCallback(ConfigChangedCallback callback) {
  _onChanged = callback;
}

uint32_t RemoteConfigManager::getSampleInterval() const {
  return _sampleInterval;
}

uint32_t RemoteConfigManager::getHeartbeatInterval() const {
  return _heartbeatInterval;
}

uint32_t RemoteConfigManager::getAppliedVersion() const {
  return _appliedVersion;
}

String RemoteConfigManager::getLastConfigId() const {
  return _lastConfigId;
}

