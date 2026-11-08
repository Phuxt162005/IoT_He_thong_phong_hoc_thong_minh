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
  uint32_t nextPublishAt = 0;
  uint32_t lastSubscribeAttemptAt = 0;

  uint32_t ackTimeoutMs = 10000;
  uint32_t retryIntervalMs = 3000;
  uint32_t maxRetryIntervalMs = 30000;
  uint32_t subscribeRetryIntervalMs = 3000;
  uint32_t queuePollIntervalMs = 1000;
  uint32_t retryCount = 0;

  bool awaitingAck = false;
  bool ackSubscribed = false;
  bool retryScheduled = false;

  bool publishNext();
  bool subscribeAck();
  void scheduleRetry(uint32_t now);
  bool validateAck(
    const String& payload,
    const String& pendingRecord,
    String& messageId
  );
  bool isValidIdentifier(const String& value) const;
  bool isTimeReached(uint32_t now, uint32_t target) const;
};