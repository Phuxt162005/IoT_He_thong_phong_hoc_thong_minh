#pragma once
#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#include "OtaMessage.h"

class OtaClient {
public:
  OtaClient(PubSubClient& mqtt, const String& deviceId,
            const String& roomId, const String& deviceType,
            const String& hardwareTarget, const String& statusTopic);

  void setPublicKey(const uint8_t publicKey[32]);
  void setCaCertificate(const char* rootCA);
  bool handleCommand(const char* topic, const uint8_t* payload, size_t length);
  void confirmBoot();

private:
  PubSubClient& _mqtt;
  String _deviceId, _roomId, _deviceType, _hardwareTarget, _statusTopic;
  uint8_t _publicKey[32] = {};
  const char* _rootCA = nullptr;
  bool _hasPublicKey = false;

  void publishStatus(const OtaCommand& command, const String& state,
                     uint8_t progress, const String& message = "");
  bool installFirmware(const OtaCommand& command);
  bool verifyDigest(const uint8_t digest[32], const String& signatureBase64);
  bool hexToBytes(const String& hex, uint8_t* output, size_t outputLength);
  bool base64ToBytes(const String& base64, uint8_t* output, size_t outputLength);
  bool validateCommand(const OtaCommand& command);
};