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
  uint64_t expiresAt = 0;
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
  String errorCode;
};

struct OtaAck {
  String jobId;
  String deviceId;
  String roomId;
  String sessionId;
  String result;
  String status;
};

bool parseOtaCommand(
  const uint8_t* payload,
  size_t length,
  OtaCommand& command
);

bool parseOtaAck(
  const uint8_t* payload,
  size_t length,
  OtaAck& ack
);

String serializeOtaStatus(const OtaStatus& status);

bool isValidHex(const String& value, size_t expectedLength);
bool isValidBase64(const String& value, size_t expectedDecodedLength);