#pragma once

#include <Arduino.h>
#include <PubSubClient.h>
#include "OfflineQueue.h"
#include "TelemetryMessage.h"

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
  uint32_t ackTimeoutMs = 10000;
  uint32_t retryIntervalMs = 3000;
  uint32_t maxRetryIntervalMs = 30000;
  uint32_t retryCount = 0;
  bool awaitingAck = false;

  bool publishNext();
  bool validateAck(
    const String& payload,
    const String& pendingRecord,
    String& messageId
  );
};