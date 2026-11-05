#include "TelemetryMessage.h"
#include <ArduinoJson.h>
#include <esp_system.h>
#include <time.h>
#include <math.h>
#include <sys/time.h>

static uint32_t messageCounter = 0;

struct timeval tv;
gettimeofday(&tv, nullptr);
const bool clockReady = tv.tv_sec >= 1700000000;

String TelemetryMessage::createMessageId() {
  // 26 ký tự, nằm trong giới hạn msg_id tối đa 64 ký tự.
  char id[27];
  const uint32_t a = esp_random();
  const uint32_t b = esp_random();
  const uint32_t c = ++messageCounter;
  snprintf(id, sizeof(id), "%08lX-%08lX-%08lX",
    (unsigned long)a, (unsigned long)b, (unsigned long)c);
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
      sample.temperatureC < -10.0f || sample.temperatureC > 60.0f ||
      sample.humidityPercent < 0.0f || sample.humidityPercent > 100.0f) {
    return false;
  }

  const String messageId = createMessageId();
  const time_t nowSeconds = time(nullptr);
  const bool clockReady = nowSeconds >= 1700000000;

  StaticJsonDocument<512> doc;

  if (clockReady) {
    // Payload chuẩn theo docs/backend-contracts.md.
    doc["msg_id"] = messageId;
    doc["device_id"] = deviceId;
    doc["room_id"] = roomId;
    doc["timestamp"] = (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);

    JsonObject data = doc.createNestedObject("data");
    data["temperature"] = sample.temperatureC;
    data["humidity"] = sample.humidityPercent;
    data["lux"] = sample.illuminanceLux;
    data["occupancy"] = sample.occupancy;
  } else {
    // Chưa đồng bộ giờ: gửi legacy timestamp rỗng.
    // Backend sẽ lưu lịch sử và đánh dấu clock_skew,
    // không dùng mẫu này để cập nhật telemetry_latest.
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
  const size_t size = serializeJson(doc, output);
  return size > 0 && size == output.length();
}