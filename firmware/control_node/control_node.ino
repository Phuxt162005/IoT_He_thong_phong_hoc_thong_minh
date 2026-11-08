#include <WiFi.h>
#include <PubSubClient.h>
#include "Config.h"
#include "NodeSessionManager.h"
#include "RemoteConfigManager.h"
#include "ActuatorManager.h"

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

NodeSessionManager sessionManager(
  mqttClient,
  DEVICE_ID,
  ROOM_ID,
  MQTT_USERNAME,
  MQTT_PASSWORD,
  FIRMWARE_VERSION,
  HEARTBEAT_INTERVAL_S
);

RemoteConfigManager configManager(
  mqttClient,
  sessionManager,
  DEVICE_ID,
  ROOM_ID,
  false,                 // isSensorNode = false (Control Node)
  0,                     // sample interval = 0
  HEARTBEAT_INTERVAL_S   // default heartbeat interval
);

ActuatorManager actuatorManager(
  mqttClient,
  sessionManager,
  DEVICE_ID,
  ROOM_ID,
  PIN_RELAY_FAN,
  PIN_RELAY_LIGHT,
  RELAY_ACTIVE_LOW
);

// Hook đồng bộ trạng thái thực tế của relay vào bản tin /status ONLINE
String getExtraStatus(const String& sessionId) {
  return actuatorManager.getReportedStatusJson();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // 1. Kiểm tra và xử lý lệnh điều khiển Relay /command
  if (actuatorManager.handleMessage(topic, payload, length)) {
    return;
  }

  // 2. Kiểm tra và xử lý cấu hình từ xa /config
  if (configManager.handleMessage(topic, payload, length)) {
    return;
  }
}

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);
  // Đăng ký topic nhận lệnh điều khiển quạt & đèn
  actuatorManager.subscribe();
  // Đăng ký topic nhận cấu hình từ xa
  configManager.subscribe();
}

void onConfigChanged(uint32_t sampleInterval, uint32_t heartbeatInterval) {
  Serial.printf("[EVENT] Cau hinh tu xa da thay doi: Heartbeat=%us\n", heartbeatInterval);
}

void setup() {
  // 1. Khởi tạo và chốt ngắt Relay NGAY LẬP TỨC ở đầu setup() để chống nháy/bật ngoài ý muốn
  actuatorManager.begin();

  Serial.begin(115200);
  delay(200);
  Serial.println("\n========================================================");
  Serial.println(" SMART CLASSROOM CONTROL NODE - ACTUATOR & COMMAND ACK");
  Serial.println("========================================================");

  // Khởi tạo Preferences NVS cho cấu hình
  configManager.begin();
  configManager.setOnConfigChangedCallback(onConfigChanged);

  // Khởi tạo kết nối Wi-Fi
  Serial.printf("[Wi-Fi] Connecting to SSID: %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Cấu hình broker MQTT và callback
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  // Cấu hình Session Manager
  sessionManager.setOnConnectedCallback(onMqttConnected);
  sessionManager.setExtraStatusPayloadHook(getExtraStatus);

  if (!sessionManager.begin()) {
    Serial.println("[ERROR] SessionManager initialization failed: " + sessionManager.lastError());
  } else {
    Serial.println("[NTP] SNTP time synchronization started (UTC).");
  }
}

void loop() {
  // Điều phối luồng duy trì kết nối, đồng bộ NTP và gửi heartbeat tự động
  sessionManager.loop();

  // In thông tin chẩn đoán ra Serial Monitor mỗi 5 giây
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint >= 5000) {
    lastPrint = millis();
    Serial.printf("[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | HB: %us | CfgVer: %u | ShadowVer: %u | Fan: %s | Light: %s\n",
      sessionManager.isWifiConnected() ? "ONLINE" : "OFFLINE",
      sessionManager.isTimeSynced() ? "SYNCED" : "SYNCING",
      sessionManager.isMqttConnected() ? "CONNECTED" : "DISCONNECTED",
      sessionManager.getSessionId().c_str(),
      configManager.getHeartbeatInterval(),
      configManager.getAppliedVersion(),
      actuatorManager.getShadowVersion(),
      actuatorManager.getFanState().c_str(),
      actuatorManager.getLightState().c_str()
    );
  }
}
