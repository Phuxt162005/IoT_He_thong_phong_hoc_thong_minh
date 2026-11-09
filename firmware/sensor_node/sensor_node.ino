#include <WiFi.h>
#include <PubSubClient.h>
#include <LittleFS.h>
#include "Config.h"
#include "NodeSessionManager.h"
#include "RemoteConfigManager.h"
#include "OfflineQueue.h"
#include "MqttSyncManager.h"
#include "SensorDrivers.h"
#include "OledDisplay.h"
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
  true,                  // isSensorNode = true
  SAMPLE_INTERVAL_S,     // default sample interval
  HEARTBEAT_INTERVAL_S   // default heartbeat interval
);

#define OTA_COMMAND_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/command"

#define OTA_ACK_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/ack"

#define OTA_STATUS_TOPIC \
  "smartclassroom/room/" ROOM_ID "/device/" DEVICE_ID "/ota/status"

#if OTA_ENABLED
bool otaStartupChecksPassed = false;
bool otaBootConfirmed = false;
uint32_t otaStartupTime = 0;
#endif

OtaClient otaClient(
  mqttClient,
  DEVICE_ID,
  ROOM_ID,
  "SENSOR_NODE",
  "ESP32",
  OTA_STATUS_TOPIC
);

OfflineQueue offlineQueue(LittleFS, 100);
MqttSyncManager syncManager(mqttClient, offlineQueue, DEVICE_ID, ROOM_ID);

SensorDrivers sensorDrivers(PIN_DHT22, PIN_I2C_SDA, PIN_I2C_SCL, PIN_PIR);
OledDisplay oledDisplay(0x3C);

uint32_t lastSampleTime = 0;
TelemetrySample currentSample;

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

  if (configManager.handleMessage(topic, payload, length)) {
    return;
  }

  syncManager.handleMessage(topic, payload, length);
}

void onMqttConnected(const String& sessionId) {
  Serial.println("[MQTT] Connected successfully! Session ID: " + sessionId);

  configManager.subscribe();
  syncManager.onMqttConnected();

#if OTA_ENABLED
  otaClient.setCurrentSessionId(sessionId);

  bool commandSubscribed = mqttClient.subscribe(OTA_COMMAND_TOPIC, 1);
  bool ackSubscribed = mqttClient.subscribe(OTA_ACK_TOPIC, 1);

  Serial.printf(
    "[OTA] Subscribe command: %s | ACK: %s\n",
    commandSubscribed ? "OK" : "FAILED",
    ackSubscribed ? "OK" : "FAILED"
  );

  otaClient.publishPendingSuccess();
#endif
}

void onConfigChanged(uint32_t sampleInterval, uint32_t heartbeatInterval) {
  Serial.printf("[EVENT] Cau hinh tu xa da thay doi: Sample=%us, Heartbeat=%us\n", sampleInterval, heartbeatInterval);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n========================================================");
  Serial.println(" SMART CLASSROOM SENSOR NODE - PHASE 3: SENSORS & OLED");
  Serial.println("========================================================");

  #if OTA_ENABLED
    otaClient.setPublicKey(OTA_ED25519_PUBLIC_KEY);
    otaClient.setCaCertificate(OTA_ROOT_CA_CERT);
  #endif
  // 1. Khoi tao man hinh OLED & Cam bien phan cung
  oledDisplay.begin();
  sensorDrivers.begin();

  // 2. Khoi tao bo nho dem LittleFS cho hang doi ngoai tuyen
  if (!LittleFS.begin(false)) {
    Serial.println(
      "[LittleFS] Mount that bai. Dung he thong de bao toan du lieu."
    );

    while (true) {
      delay(1000);
    }
  }

  Serial.println("[LittleFS] LittleFS san sang.");

  if (!syncManager.begin()) {
    Serial.println(
      "[OfflineQueue] Khoi tao that bai: " +
      syncManager.lastError()
    );
    Serial.println(
      "[FATAL] Dung Sensor Node de tranh mat du lieu telemetry."
    );

    while (true) {
      delay(1000);
    }
  }

  Serial.println(
    "[OfflineQueue] Sync manager san sang. So ban tin ton dong: " +
    String(syncManager.queuedCount())
  );

  // 3. Khoi tao Preferences NVS cho cau hinh tu xa
  configManager.begin();
  configManager.setOnConfigChangedCallback(onConfigChanged);

  // 4. Khoi tao ket noi Wi-Fi
  Serial.printf("[Wi-Fi] Connecting to SSID: %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // 5. Cau hinh broker MQTT va callback (kem timeout ngan de tranh treo man hinh OLED khi mat mang)
  wifiClient.setConnectionTimeout(300); // 300ms timeout ket noi TCP
  mqttClient.setSocketTimeout(1);       // 1 giay timeout socket
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  // 6. Cau hinh Session Manager
  sessionManager.setOnConnectedCallback(onMqttConnected);
  if (!sessionManager.begin()) {
    Serial.println("[ERROR] SessionManager initialization failed: " + sessionManager.lastError());
  } else {
    Serial.println("[NTP] SNTP time synchronization started (UTC).");
  }

  // Doc thu mau cam bien ban dau
  #if OTA_ENABLED
    otaStartupChecksPassed = sensorDrivers.readSample(currentSample);
    otaStartupTime = millis();
    Serial.printf(
      "[OTA] Startup sensor check: %s\n",
      otaStartupChecksPassed ? "PASSED" : "FAILED"
    );
  #else
    sensorDrivers.readSample(currentSample);
  #endif
}

void loop() {
  // 1. Dieu phoi duy tri ket noi Wi-Fi, MQTT, dong bo NTP va gui heartbeat
  sessionManager.loop();
  #if OTA_ENABLED
    if (!otaBootConfirmed &&
        otaStartupChecksPassed &&
        millis() - otaStartupTime >= 30000) {
      otaBootConfirmed = otaClient.confirmBoot();
    }
    otaClient.publishPendingSuccess();
  #endif
  // 2. Dieu phoi dong bo du lieu cam bien (gui telemetry va xu ly bu du lieu ngoai tuyen)
  syncManager.loop();

  // 3. Doc du lieu cam bien theo chu ky cau hinh tu xa
  uint32_t now = millis();
  uint32_t sampleIntervalMs = configManager.getSampleInterval() * 1000;
  if (now - lastSampleTime >= sampleIntervalMs) {
    lastSampleTime = now;

    if (sensorDrivers.readSample(currentSample)) {
      // Dua mau do vao hang doi dong bo MQTT (co mang thi ban ngay, mat mang thi luu LittleFS)
      if (!syncManager.enqueueSample(currentSample)) {
        Serial.println(
          "[OfflineQueue] KHONG LUU DUOC TELEMETRY: " +
          syncManager.lastError()
        );
      } else {
        Serial.printf(
          "[OfflineQueue] Da tiep nhan telemetry. Queue=%u\n",
          (unsigned int)syncManager.queuedCount()
        );
      }

      Serial.printf("[Sensor] Doc mau: T=%.1f C | H=%.1f %% | Lux=%u | Occ=%s | Queue=%u\n",
        currentSample.temperatureC,
        currentSample.humidityPercent,
        currentSample.illuminanceLux,
        currentSample.occupancy ? "CO NGUOI" : "TRONG",
        (unsigned int)syncManager.queuedCount()
      );
    }
  }

  // 4. Cap nhat man hinh OLED dinh ky moi 1 giay
  static uint32_t lastOledUpdate = 0;
  if (now - lastOledUpdate >= 1000) {
    lastOledUpdate = now;
    oledDisplay.update(
      currentSample,
      sessionManager.isWifiConnected(),
      sessionManager.isMqttConnected(),
      syncManager.queuedCount(),
      configManager.getSampleInterval(),
      configManager.getHeartbeatInterval()
    );
  }

  // 5. In thong tin chan doan ra Serial Monitor moi 5 giay
  static uint32_t lastPrint = 0;
  if (now - lastPrint >= 5000) {
    lastPrint = now;
    Serial.printf("[Chẩn đoán] Wi-Fi: %s | NTP: %s | MQTT: %s | Session: %s | Sample: %us | HB: %us | CfgVer: %u | Queue: %u\n",
      sessionManager.isWifiConnected() ? "ONLINE" : "OFFLINE",
      sessionManager.isTimeSynced() ? "SYNCED" : "SYNCING",
      sessionManager.isMqttConnected() ? "CONNECTED" : "DISCONNECTED",
      sessionManager.getSessionId().c_str(),
      configManager.getSampleInterval(),
      configManager.getHeartbeatInterval(),
      configManager.getAppliedVersion(),
      (unsigned int)syncManager.queuedCount()
    );
  }
}
