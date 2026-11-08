#include <WiFi.h>
#include <PubSubClient.h>
#include "Config.h"
#include "NodeSessionManager.h"

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

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n========================================================");
  Serial.println(" SMART CLASSROOM SENSOR NODE - PHASE 1: SESSION & HEARTBEAT");
  Serial.println("========================================================");

  // Khởi tạo kết nối Wi-Fi
  Serial.printf("[Wi-Fi] Connecting to SSID: %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Cấu hình broker MQTT
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);

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
    Serial.printf("[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | RSSI: %d dBm | Free Heap: %u bytes\n",
      sessionManager.isWifiConnected() ? "ONLINE" : "OFFLINE",
      sessionManager.isTimeSynced() ? "SYNCED" : "SYNCING",
      sessionManager.isMqttConnected() ? "CONNECTED" : "DISCONNECTED",
      sessionManager.getSessionId().c_str(),
      WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -127,
      ESP.getFreeHeap()
    );
  }
}
