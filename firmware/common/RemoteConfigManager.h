#pragma once
#include <Arduino.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <functional>
#include "NodeSessionManager.h"

// Callback thông báo khi có cấu hình mới được áp dụng thành công
typedef std::function<void(uint32_t sampleInterval, uint32_t heartbeatInterval)> ConfigChangedCallback;

class RemoteConfigManager {
public:
  RemoteConfigManager(
    PubSubClient& mqtt,
    NodeSessionManager& sessionManager,
    const String& deviceId,
    const String& roomId,
    bool isSensorNode = true,
    uint32_t defaultSampleInterval = 5,
    uint32_t defaultHeartbeatInterval = 10
  );

  // Khởi tạo Preferences (NVS), nạp cấu hình đã lưu trước đó nếu có
  bool begin();

  // Đăng ký nhận topic cấu hình (gọi khi MQTT kết nối thành công)
  bool subscribe();

  // Xử lý gói tin MQTT nhận được trong callback
  bool handleMessage(const char* topic, const uint8_t* payload, size_t length);

  // Đăng ký callback khi cấu hình thay đổi
  void setOnConfigChangedCallback(ConfigChangedCallback callback);

  // Truy vấn các thông số cấu hình đang áp dụng
  uint32_t getSampleInterval() const;
  uint32_t getHeartbeatInterval() const;
  uint32_t getAppliedVersion() const;
  String getLastConfigId() const;

private:
  PubSubClient& _mqtt;
  NodeSessionManager& _session;
  String _deviceId;
  String _roomId;
  bool _isSensorNode;

  String _configTopic;
  String _ackTopic;

  uint32_t _sampleInterval;
  uint32_t _heartbeatInterval;
  uint32_t _appliedVersion = 0;
  String _lastConfigId = "";

  Preferences _prefs;
  ConfigChangedCallback _onChanged = nullptr;

  void sendAck(
    const String& configId,
    uint32_t version,
    bool success,
    const String& errorCode = "",
    const String& appliedSettingsJson = ""
  );
};

