#include <WiFi.h>
#include <LittleFS.h>
#include <PubSubClient.h>
#include "OfflineQueue.h"
#include "MqttSyncManager.h"

#ifndef WIFI_SSID
#error "WIFI_SSID must be configured"
#endif
#ifndef WIFI_PASSWORD
#error "WIFI_PASSWORD must be configured"
#endif
#ifndef MQTT_HOST
#error "MQTT_HOST must be configured"
#endif
#ifndef MQTT_PORT
#error "MQTT_PORT must be configured"
#endif
#ifndef DEVICE_ID
#error "DEVICE_ID must be configured"
#endif
#ifndef ROOM_ID
#error "ROOM_ID must be configured"
#endif
#ifndef MQTT_USERNAME
#error "MQTT_USERNAME must be configured"
#endif
#ifndef MQTT_PASSWORD
#error "MQTT_PASSWORD must be configured"
#endif

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

OfflineQueue offlineQueue(LittleFS, 100);
MqttSyncManager* syncManager = nullptr;

uint32_t lastWifiAttempt = 0;
uint32_t lastMqttAttempt = 0;
uint32_t lastSampleAt = 0;

bool previousMqttState = false;

const uint32_t RECONNECT_INTERVAL_MS = 5000;
const uint32_t SAMPLE_INTERVAL_MS = 5000;

bool readSensorSample(TelemetrySample& sample) {
  // Người tích hợp phần cứng thay phần này bằng driver cảm biến.
  // Không gửi dữ liệu giả lên backend.
  return false;
}

void mqttCallback(
  char* topic,
  byte* payload,
  unsigned int length
) {
  if (syncManager) {
    syncManager->handleMessage(topic, payload, length);
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (mqttClient.connected() ||
      WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (mqttClient.connect(
        DEVICE_ID,
        MQTT_USERNAME,
        MQTT_PASSWORD
      )) {
    Serial.println("MQTT connected");
  } else {
    Serial.printf(
      "MQTT connection failed: %d\n",
      mqttClient.state()
    );
  }
}

void setup() {
  Serial.begin(115200);

  if (!LittleFS.begin(false)) {
    Serial.println("LittleFS mount failed; stop to protect data");
    while (true) delay(1000);
  }

  syncManager = new MqttSyncManager(
    mqttClient,
    offlineQueue,
    DEVICE_ID,
    ROOM_ID
  );

  if (!syncManager->begin()) {
    Serial.println(syncManager->lastError());
    while (true) delay(1000);
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(2048);
  mqttClient.setKeepAlive(30);

  Serial.printf(
    "Recovered offline records: %u\n",
    (unsigned)syncManager->queuedCount()
  );

  connectWiFi();
}

void loop() {
  const uint32_t now = millis();

  if (WiFi.status() != WL_CONNECTED &&
      now - lastWifiAttempt >= RECONNECT_INTERVAL_MS) {
    lastWifiAttempt = now;
    connectWiFi();
  }

  if (WiFi.status() == WL_CONNECTED &&
      !mqttClient.connected() &&
      now - lastMqttAttempt >= RECONNECT_INTERVAL_MS) {
    lastMqttAttempt = now;
    connectMqtt();
  }

  mqttClient.loop();

  const bool currentMqttState = mqttClient.connected();

  if (currentMqttState && !previousMqttState) {
    if (!syncManager->onMqttConnected()) {
      Serial.println(syncManager->lastError());
    }
  }

  previousMqttState = currentMqttState;

  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;

    TelemetrySample sample;
    if (readSensorSample(sample)) {
      if (!syncManager->enqueueSample(sample)) {
        Serial.println(syncManager->lastError());
      }
    }
  }

  syncManager->loop();
}