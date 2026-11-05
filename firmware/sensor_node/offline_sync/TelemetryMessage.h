#pragma once
#include <Arduino.h>

struct TelemetrySample {
  float temperatureC;
  float humidityPercent;
  uint16_t illuminanceLux;
  bool occupancy;
};

class TelemetryMessage {
public:
  static bool build(
    const String& deviceId,
    const String& roomId,
    const TelemetrySample& sample,
    String& output
  );

private:
  static String createMessageId();
};