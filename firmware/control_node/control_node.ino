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

// Trạng thái quạt và đèn ban đầu (khi mới cấp nguồn)
String currentFanState = "OFF";
String currentLightState = "OFF";
uint32_t currentShadowVersion = 1;

// Hook bổ sung reported_state và shadow_version vào bản tin /status ONLINE
String getExtraStatus(const String& sessionId) {
  return "{\"reported_state\":{\"fan\":\"" + currentFanState + "\",\"light\":\"" + currentLightState + "\"},\"shadow_version\":" + String(currentShadowVersion) + "}";
}

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n========================================================");
  Serial.println(" SMART CLASSROOM CONTROL NODE - PHASE 1: SESSION & HEARTBEAT");
  Serial.println("========================================================");

  // Khởi tạo trạng thái Relay K1 (GPIO 25 - Quạt) và K2 (GPIO 26 - Đèn)
  // Ghi trước mức logic tắt để chống hiện tượng nháy relay lúc vừa cấp điện
  #if RELAY_ACTIVE_LOW
    digitalWrite(PIN_RELAY_FAN, HIGH);
    digitalWrite(PIN_RELAY_LIGHT, HIGH);
  #else
    digitalWrite(PIN_RELAY_FAN, LOW);
    digitalWrite(PIN_RELAY_LIGHT, LOW);
  #endif
  pinMode(PIN_RELAY_FAN, OUTPUT);
  pinMode(PIN_RELAY_LIGHT, OUTPUT);
  Serial.println("[Relay] Initialized GPIO 25 (FAN) and GPIO 26 (LIGHT) to OFF.");

  // Khởi tạo kết nối Wi-Fi
  Serial.printf("[Wi-Fi] Connecting to SSID: %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Cấu hình broker MQTT
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);

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
    Serial.printf("[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | Fan: %s | Light: %s\n",
      sessionManager.isWifiConnected() ? "ONLINE" : "OFFLINE",
      sessionManager.isTimeSynced() ? "SYNCED" : "SYNCING",
      sessionManager.isMqttConnected() ? "CONNECTED" : "DISCONNECTED",
      sessionManager.getSessionId().c_str(),
      currentFanState.c_str(),
      currentLightState.c_str()
    );
  }
}

