#include <WiFi.h>
#include <PubSubClient.h>
#include "Config.h"
#include "NodeSessionManager.h"
#include "RemoteConfigManager.h"

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
  true,                  // isSensorNode = true
  SAMPLE_INTERVAL_S,     // default sample interval
  HEARTBEAT_INTERVAL_S   // default heartbeat interval
);

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Chuyển tiếp bản tin nhận được tới RemoteConfigManager
  if (configManager.handleMessage(topic, payload, length)) {
    return;
  }
}

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);
  // Đăng ký nhận cấu hình từ xa khi vừa kết nối MQTT
  configManager.subscribe();
}

void onConfigChanged(uint32_t sampleInterval, uint32_t heartbeatInterval) {
  Serial.printf("[EVENT] Cau hinh tu xa da thay doi: Sample=%us, Heartbeat=%us\n", sampleInterval, heartbeatInterval);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n========================================================");
  Serial.println(" SMART CLASSROOM SENSOR NODE - PHASE 2: REMOTE CONFIG");
  Serial.println("========================================================");

  // Khởi tạo Preferences NVS và nạp cấu hình đã lưu
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
    Serial.printf("[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | Sample: %us | HB: %us | CfgVer: %u\n",
      sessionManager.isWifiConnected() ? "ONLINE" : "OFFLINE",
      sessionManager.isTimeSynced() ? "SYNCED" : "SYNCING",
      sessionManager.isMqttConnected() ? "CONNECTED" : "DISCONNECTED",
      sessionManager.getSessionId().c_str(),
      configManager.getSampleInterval(),
      configManager.getHeartbeatInterval(),
      configManager.getAppliedVersion()
    );
  }
}
