#include "TelemetryMessage.h"
#include <ArduinoJson.h>
#include <esp_system.h>
#include <sys/time.h>
#include <math.h>
#include <stdio.h>

static uint32_t messageCounter = 0;

static bool isValidIdentifier(const String& value) {
  if (value.isEmpty() || value.length() > 40) return false;

  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];

    if (!((c >= 'A' && c <= 'Z') ||
          (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') ||
          c == '_' || c == '-')) {
      return false;
    }
  }

  return true;
}

String TelemetryMessage::createMessageId() {
  char id[27];

  snprintf(
    id,
    sizeof(id),
    "%08lX-%08lX-%08lX",
    (unsigned long)esp_random(),
    (unsigned long)esp_random(),
    (unsigned long)++messageCounter
  );

  return String(id);
}

bool TelemetryMessage::build(
  const String& deviceId,
  const String& roomId,
  const TelemetrySample& sample,
  String& output
) {
  output = "";

  if (!isValidIdentifier(deviceId) ||
      !isValidIdentifier(roomId)) {
    return false;
  }

  if (!isfinite(sample.temperatureC) ||
      !isfinite(sample.humidityPercent) ||
      sample.temperatureC < -10.0f ||
      sample.temperatureC > 60.0f ||
      sample.humidityPercent < 0.0f ||
      sample.humidityPercent > 100.0f) {
    return false;
  }

  struct timeval tv = {};

  const bool clockAvailable = gettimeofday(&tv, nullptr) == 0;

  const bool clockReady = clockAvailable && tv.tv_sec >= 1700000000;

  StaticJsonDocument<512> doc;

  const String messageId = createMessageId();

  if (clockReady) {
    // Payload chuẩn theo hợp đồng Backend.
    doc["msg_id"] = messageId;
    doc["device_id"] = deviceId;
    doc["room_id"] = roomId;

    doc["timestamp"] =
      (uint64_t)tv.tv_sec * 1000ULL +
      (uint64_t)(tv.tv_usec / 1000);

    JsonObject data = doc.createNestedObject("data");

    data["temperature"] = sample.temperatureC;
    data["humidity"] = sample.humidityPercent;
    data["lux"] = sample.illuminanceLux;
    data["occupancy"] = sample.occupancy;

  } else {
    // Payload legacy khi đồng hồ chưa đồng bộ.
    doc["messageType"] = "telemetry";
    doc["eventId"] = messageId;
    doc["deviceId"] = deviceId;
    doc["roomCode"] = roomId;
    doc["timestamp"] = "";

    doc["temperatureC"] = sample.temperatureC;
    doc["humidityPercent"] = sample.humidityPercent;
    doc["illuminanceLux"] = sample.illuminanceLux;
    doc["occupancy"] = sample.occupancy;
  }

  const size_t written = serializeJson(doc, output);

  return written > 0 && written == output.length();
}