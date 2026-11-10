#include <WiFi.h>
#include <PubSubClient.h>
#include "Config.h"
#include "NodeSessionManager.h"
#include "RemoteConfigManager.h"
#include "ActuatorManager.h"
#include "src/ota/OtaClient.h"

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

#define OTA_COMMAND_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/command"

#define OTA_ACK_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/ack"

#define OTA_STATUS_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/status"

#if OTA_ENABLED
bool otaStartupChecksPassed = false;
bool otaBootDecisionMade = false;
uint32_t otaStartupTime = 0;
#endif

OtaClient otaClient(
  mqttClient,
  DEVICE_ID,
  ROOM_ID,
  "CONTROL_NODE",
  "ESP32",
  OTA_STATUS_TOPIC
);

// Hook đồng bộ trạng thái thực tế của relay vào bản tin /status ONLINE
String getExtraStatus(const String& sessionId) {
  return actuatorManager.getReportedStatusJson();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  #if OTA_ENABLED
    String topicName(topic);

    if (topicName == OTA_COMMAND_TOPIC) {
      otaClient.handleCommand(topic, payload, length);
      return;
    }

    if (topicName == OTA_ACK_TOPIC) {
      otaClient.handleAck(topic, payload, length);
      return;
    }
  #endif

  if (actuatorManager.handleMessage(topic, payload, length)) {
    return;
  }

  if (configManager.handleMessage(topic, payload, length)) {
    return;
  }
}

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);

  actuatorManager.subscribe();
  configManager.subscribe();

  #if OTA_ENABLED
    otaClient.setCurrentSessionId(sessionId);

    bool commandSubscribed = mqttClient.subscribe(OTA_COMMAND_TOPIC, 1);
    bool ackSubscribed = mqttClient.subscribe(OTA_ACK_TOPIC, 1);

    Serial.printf(
      "[OTA] Subscribe command: %s | ACK: %s\n",
      commandSubscribed ? "OK" : "FAILED",
      ackSubscribed ? "OK" : "FAILED"
    );
  #endif
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
  #if OTA_ENABLED
    otaClient.setPublicKey(OTA_ED25519_PUBLIC_KEY);
    otaClient.setCaCertificate(OTA_ROOT_CA_CERT);
  #endif
  // Khởi tạo Preferences NVS cho cấu hình
  configManager.begin();
  configManager.setOnConfigChangedCallback(onConfigChanged);

  // Khởi tạo kết nối Wi-Fi
  Serial.printf("[Wi-Fi] Connecting to SSID: %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Cấu hình broker MQTT va callback (kèm timeout nhanh để chống nghẽn)
  wifiClient.setConnectionTimeout(300);
  mqttClient.setSocketTimeout(1);
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

  #if OTA_ENABLED
    otaStartupChecksPassed =
      actuatorManager.isReady() &&
      actuatorManager.getFanState() == "OFF" &&
      actuatorManager.getLightState() == "OFF";

    otaStartupTime = millis();

    Serial.printf(
      "[OTA] Startup actuator check: %s\n",
      otaStartupChecksPassed ? "PASSED" : "FAILED"
    );
  #endif
}

void loop() {
  sessionManager.loop();

  #if OTA_ENABLED
    if (!otaBootDecisionMade &&
        millis() - otaStartupTime >= 30000) {

      otaBootDecisionMade = true;

      if (otaStartupChecksPassed) {
        Serial.println("[OTA] Startup checks passed. Confirming firmware.");
        otaClient.confirmBoot();
      } else {
        otaClient.rollbackBoot("Control startup check failed");
      }
    }

    otaClient.publishPendingSuccess();
  #endif

  actuatorManager.loop();

  static uint32_t lastPrint = 0;

  if (millis() - lastPrint >= 5000) {
    lastPrint = millis();

    Serial.printf(
      "[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | HB: %us | CfgVer: %u | ShadowVer: %u | Fan: %s | Light: %s\n",
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