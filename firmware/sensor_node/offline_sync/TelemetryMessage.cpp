#include "TelemetryMessage.h"
#include <ArduinoJson.h>
#include <esp_system.h>
#include <sys/time.h>
#include <math.h>
#include <stdio.h>

static uint32_t messageCounter = 0;

String TelemetryMessage::createMessageId() {
  char id[27];
  snprintf(id, sizeof(id), "%08lX-%08lX-%08lX",
    (unsigned long)esp_random(),
    (unsigned long)esp_random(),
    (unsigned long)++messageCounter);
  return String(id);
}

bool TelemetryMessage::build(
  const String& deviceId,
  const String& roomId,
  const TelemetrySample& sample,
  String& output
) {
  if (deviceId.isEmpty() || roomId.isEmpty()) return false;

  if (!isfinite(sample.temperatureC) ||
      !isfinite(sample.humidityPercent) ||
      sample.temperatureC < -10.0f ||
      sample.temperatureC > 60.0f ||
      sample.humidityPercent < 0.0f ||
      sample.humidityPercent > 100.0f) {
    return false;
  }

  struct timeval tv;
  gettimeofday(&tv, nullptr);
  const bool clockReady = tv.tv_sec >= 1700000000;

  StaticJsonDocument<512> doc;
  const String messageId = createMessageId();

  if (clockReady) {
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

  output = "";
  const size_t written = serializeJson(doc, output);
  return written > 0 && written == output.length();
}