#pragma once
#include <Arduino.h>

struct OtaCommand {
  String jobId;
  String deviceId;
  String roomId;
  String sessionId;
  String firmwareId;
  String version;
  String deviceType;
  String hardwareTarget;
  String downloadUrl;
  String sha256;
  String signature;
  String expiresAt;
  size_t fileSize = 0;
};

struct OtaStatus {
  String jobId;
  String deviceId;
  String roomId;
  String sessionId;
  String version;
  String status;
  uint8_t progress = 0;
  String message;
};

bool parseOtaCommand(const uint8_t* payload, size_t length, OtaCommand& command);
String serializeOtaStatus(const OtaStatus& status);
bool isValidHex(const String& value, size_t expectedLength);