#include "OtaMessage.h"
#include <ArduinoJson.h>
#include <time.h>

bool isValidHex(const String& value, size_t expectedLength) {
  if (value.length() != expectedLength) return false;

  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (!((c >= '0' && c <= '9') ||
          (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

bool parseOtaCommand(const uint8_t* payload, size_t length, OtaCommand& c) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) return false;

  c.jobId = doc["job_id"] | "";
  c.deviceId = doc["device_id"] | "";
  c.roomId = doc["room_id"] | "";
  c.sessionId = doc["session_id"] | "";
  c.firmwareId = doc["firmware_id"] | "";
  c.version = doc["version"] | "";
  c.deviceType = doc["device_type"] | "";
  c.hardwareTarget = doc["hardware_target"] | "";
  c.downloadUrl = doc["download_url"] | "";
  c.fileSize = doc["file_size"] | 0;
  c.sha256 = doc["sha256"] | "";
  c.signature = doc["signature"] | "";
  c.expiresAt = doc["expires_at"] | "";

  if (c.jobId.isEmpty() || c.deviceId.isEmpty() ||
      c.firmwareId.isEmpty() || c.version.isEmpty() ||
      c.downloadUrl.isEmpty() || c.fileSize == 0) return false;

  if (!c.downloadUrl.startsWith("https://")) return false;
  if (!isValidHex(c.sha256, 64)) return false;
  if (!isValidHex(c.signature, 128)) return false;

  return true;
}

String serializeOtaStatus(const OtaStatus& s) {
  JsonDocument doc;

  doc["job_id"] = s.jobId;
  doc["device_id"] = s.deviceId;
  doc["room_id"] = s.roomId;
  doc["session_id"] = s.sessionId;
  doc["version"] = s.version;
  doc["status"] = s.status;
  doc["progress"] = s.progress;

  // Unix timestamp tính bằng milliseconds.
  doc["timestamp"] = (uint64_t)time(nullptr) * 1000ULL;

  String output;
  serializeJson(doc, output);
  return output;
}