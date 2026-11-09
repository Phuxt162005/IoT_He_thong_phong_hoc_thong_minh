#pragma once

#include <Arduino.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include "NodeSessionManager.h"

class ActuatorManager {
public:
  ActuatorManager(
    PubSubClient& mqtt,
    NodeSessionManager& session,
    const String& deviceId,
    const String& roomId,
    uint8_t pinFan = 25,
    uint8_t pinLight = 26,
    bool activeLow = true
  );

  void begin();
  bool subscribe();
  bool handleMessage(
    const char* topic,
    const uint8_t* payload,
    size_t length
  );
  bool isReady() const;
  
  void loop();

  String getFanState() const;
  String getLightState() const;
  uint32_t getShadowVersion() const;
  String getReportedStatusJson() const;

  void setFan(bool on);
  void setLight(bool on);

private:
  PubSubClient& _mqtt;
  NodeSessionManager& _session;

  String _deviceId;
  String _roomId;

  uint8_t _pinFan;
  uint8_t _pinLight;
  bool _activeLow;

  String _commandTopic;
  String _ackTopic;
  String _reportedTopic;

  Preferences _prefs;

  bool _prefsReady = false;
  bool _storageFault = false;

  bool _fanOn = false;
  bool _lightOn = false;

  uint32_t _shadowVersion = 1;
  String _lastProcessedCommandId;

  static const size_t DEDUP_SIZE = 16;
  String _recentCommandIds[DEDUP_SIZE];
  size_t _dedupIndex = 0;

  static const size_t ACK_QUEUE_SIZE = 8;

  struct PendingAck {
    String commandId;
    String sessionId;
    uint32_t version;
    bool success;
    String errorCode;
    String fanState;
    String lightState;
  };

  PendingAck _ackQueue[ACK_QUEUE_SIZE];
  size_t _ackHead = 0;
  size_t _ackCount = 0;
  uint32_t _lastAckAttemptMs = 0;

  bool enqueueAck(const PendingAck& ack);

  bool isCommandProcessed(const String& cmdId);
  void markCommandProcessed(const String& cmdId);

  void writeHardware(uint8_t pin, bool on);
  void forceAllOff();

  bool saveCommandMetadata(
    uint32_t version,
    const String& commandId
  );

  bool sendAck(
    const String& commandId,
    uint32_t version,
    bool success,
    const String& errorCode = ""
  );

  bool publishAck(const String& payload);
};