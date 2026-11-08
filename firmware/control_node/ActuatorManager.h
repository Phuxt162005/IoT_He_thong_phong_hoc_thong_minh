
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
  bool handleMessage(const char* topic, const uint8_t* payload, size_t length);

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

  bool _fanOn = false;
  bool _lightOn = false;
  uint32_t _shadowVersion = 1;

  // Lưu ID lệnh gần nhất trong NVS để nhận diện duplicate sau reboot.
  String _lastProcessedCommandId;

  // Bộ nhớ đệm RAM để nhận diện các lệnh lặp trong phiên hiện tại.
  static const size_t DEDUP_SIZE = 16;
  String _recentCommandIds[DEDUP_SIZE];
  size_t _dedupIndex = 0;

  bool isCommandProcessed(const String& cmdId);
  void markCommandProcessed(const String& cmdId);
  void writeHardware(uint8_t pin, bool on);

  bool sendAck(
    const String& commandId,
    uint32_t version,
    bool success,
    const String& errorCode = ""
  );
};
