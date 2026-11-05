#pragma once
#include <Arduino.h>
#include <PubSubClient.h>
#include "OfflineQueue.h"
#include "TelemetryMessage.h"
#include <LittleFS.h>
#include <PubSubClient.h>
#include "OfflineQueue.h"
#include "MqttSyncManager.h"

OfflineQueue offlineQueue(LittleFS, 100);
MqttSyncManager* syncManager = nullptr;

void setupOfflineSync(PubSubClient& mqtt, const String& deviceId, const String& roomId) {
  syncManager = new MqttSyncManager(mqtt, offlineQueue, deviceId, roomId);
  if (!syncManager->begin()) {
    Serial.println(syncManager->lastError());
    return;
  }
  Serial.printf("Offline queue: %u records\n", (unsigned)syncManager->queuedCount());
}

void mqttMessageCallback(char* topic, byte* payload, unsigned int length) {
  if (syncManager) syncManager->handleMessage(topic, payload, length);
}

class MqttSyncManager {
public:
  MqttSyncManager(
    PubSubClient& mqtt,
    OfflineQueue& queue,
    const String& deviceId,
    const String& roomId
  );

  bool begin();
  bool enqueueSample(const TelemetrySample& sample);
  bool onMqttConnected();
  void handleMessage(char* topic, byte* payload, unsigned int length);
  void loop();

  size_t queuedCount();
  String lastError() const;

private:
  PubSubClient& mqtt;
  OfflineQueue& queue;
  String deviceId;
  String roomId;
  String telemetryTopic;
  String ackTopic;
  String errorMessage;

  uint32_t lastPublishAt = 0;
  uint32_t retryIntervalMs = 3000;
  uint32_t maxRetryIntervalMs = 30000;
  uint32_t retryCount = 0;

  bool publishNext();
  bool validateAck(
    const String& payload,
    const String& pendingRecord,
    String& messageId
  );
};