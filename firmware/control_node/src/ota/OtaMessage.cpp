#include "OtaMessage.h"
#include <ArduinoJson.h>
#include <time.h>

bool isValidHex(const String& value, size_t expectedLength) {
  if (value.length() != expectedLength) return false;

  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];

    if (!((c >= '0' && c <= '9') ||
          (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) {
      return false;
    }
  }

  return true;
}

bool isValidBase64(
  const String& value,
  size_t expectedDecodedLength
) {
  if (value.isEmpty() || value.length() % 4 != 0) {
    return false;
  }

  size_t padding = 0;

  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }

  size_t decodedLength = (value.length() / 4) * 3 - padding;

  if (decodedLength != expectedDecodedLength) {
    return false;
  }

  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];

    bool valid =
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      c == '+' || c == '/' || c == '=';

    if (!valid) return false;

    if (c == '=' && i < value.length() - padding) {
      return false;
    }
  }

  return true;
}

bool parseOtaCommand(
  const uint8_t* payload,
  size_t length,
  OtaCommand& c
) {
  DynamicJsonDocument doc(2048);

  if (deserializeJson(doc, payload, length)) {
    return false;
  }

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
  c.expiresAt = doc["expires_at"] | 0ULL;

  if (c.jobId.isEmpty() ||
      c.deviceId.isEmpty() ||
      c.roomId.isEmpty() ||
      c.sessionId.isEmpty() ||
      c.firmwareId.isEmpty() ||
      c.version.isEmpty() ||
      c.deviceType.isEmpty() ||
      c.hardwareTarget.isEmpty() ||
      c.downloadUrl.isEmpty() ||
      c.fileSize == 0) {
    return false;
  }

  if (!c.downloadUrl.startsWith("https://") && !c.downloadUrl.startsWith("http://")) return false;
  if (!isValidHex(c.sha256, 64)) return false;

  // Ed25519 signature: 64 bytes, Base64 encoded.
  if (!isValidBase64(c.signature, 64)) return false;

  return true;
}

bool parseOtaAck(
  const uint8_t* payload,
  size_t length,
  OtaAck& ack
) {
  DynamicJsonDocument doc(512);

  if (deserializeJson(doc, payload, length)) {
    return false;
  }

  ack.jobId = doc["job_id"] | "";
  ack.deviceId = doc["device_id"] | "";
  ack.roomId = doc["room_id"] | "";
  ack.sessionId = doc["session_id"] | "";
  ack.result = doc["result"] | "";
  ack.status = doc["status"] | "";

  return !ack.jobId.isEmpty() &&
         !ack.deviceId.isEmpty() &&
         !ack.roomId.isEmpty() &&
         !ack.sessionId.isEmpty() &&
         ack.result == "PROCESSED" &&
         !ack.status.isEmpty();
}

String serializeOtaStatus(const OtaStatus& s) {
  StaticJsonDocument<512> doc;

  doc["job_id"] = s.jobId;
  doc["device_id"] = s.deviceId;
  doc["room_id"] = s.roomId;
  doc["session_id"] = s.sessionId;
  doc["version"] = s.version;
  doc["status"] = s.status;
  doc["progress"] = s.progress;

  if (!s.errorCode.isEmpty()) {
    doc["error_code"] = s.errorCode;
  }

  doc["timestamp"] = (uint64_t)time(nullptr) * 1000ULL;

  String output;
  serializeJson(doc, output);

  return output;
}