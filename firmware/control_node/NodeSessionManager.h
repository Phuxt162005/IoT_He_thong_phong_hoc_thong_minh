#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <functional>

typedef std::function<void(const String& sessionId)> MqttConnectedCallback;
typedef std::function<String(const String& sessionId)> ExtraStatusPayloadCallback;

class NodeSessionManager {
public:
  NodeSessionManager(
    PubSubClient& mqtt,
    const String& deviceId,
    const String& roomId,
    const String& mqttUsername,
    const String& mqttPassword,
    const String& firmwareVersion = "1.0.0",
    uint32_t heartbeatIntervalSeconds = 10
  );

  // Khởi tạo các thông số, cấu hình NTP và thiết lập bộ đệm MQTT
  bool begin();

  // Đăng ký callback khi MQTT kết nối thành công (dùng để subscribe topics)
  void setOnConnectedCallback(MqttConnectedCallback callback);

  // Đăng ký hook mở rộng payload status (ví dụ: Control Node bổ sung reported_state và shadow_version)
  void setExtraStatusPayloadHook(ExtraStatusPayloadCallback hook);

  // Cập nhật và truy vấn chu kỳ heartbeat
  void setHeartbeatInterval(uint32_t seconds);
  uint32_t getHeartbeatInterval() const;

  // Lấy session_id của phiên kết nối hiện tại
  String getSessionId() const;

  // Trạng thái kết nối và đồng bộ thời gian
  bool isWifiConnected() const;
  bool isMqttConnected() const;
  bool isTimeSynced() const;

  // Lấy thời gian UTC (mili giây). Trả về 0 nếu chưa đồng bộ NTP.
  uint64_t getNowMs() const;

  // Vòng lặp điều phối (non-blocking) cần được gọi định kỳ trong loop()
  void loop();

  // Chủ động ngắt kết nối MQTT
  void disconnect();

  // Chủ động gửi bản tin heartbeat
  bool publishHeartbeat();

  // Thông báo lỗi gần nhất
  String lastError() const;

private:
  PubSubClient& _mqtt;
  String _deviceId;
  String _roomId;
  String _mqttUsername;
  String _mqttPassword;
  String _firmwareVersion;
  uint32_t _heartbeatIntervalSeconds;

  String _sessionId;
  String _statusTopic;
  String _heartbeatTopic;
  String _errorMessage;

  uint32_t _lastHeartbeatMillis = 0;
  uint32_t _lastUptimeSeconds = 0;
  uint32_t _messageCounter = 0;
  uint32_t _lastWifiAttemptMillis = 0;
  uint32_t _lastMqttAttemptMillis = 0;

  bool _timeSynced = false;
  bool _onlineStatusPublished = false;

  MqttConnectedCallback _onConnectedCallback = nullptr;
  ExtraStatusPayloadCallback _extraStatusHook = nullptr;

  String generateSessionId();
  String generateMsgId();
  bool connectMqtt();
  bool publishOnlineStatus();
  bool isValidIdentifier(const String& val) const;
};
