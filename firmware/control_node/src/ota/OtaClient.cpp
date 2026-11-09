#include "OtaClient.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <esp_ota_ops.h>
#include "monocypher-ed25519.h"
#include <mbedtls/base64.h>
#include <Preferences.h>
#include <time.h>
#include <esp_app_desc.h>

OtaClient::OtaClient(PubSubClient& mqtt, const String& deviceId,
                     const String& roomId, const String& deviceType,
                     const String& hardwareTarget, const String& statusTopic)
  : _mqtt(mqtt), _deviceId(deviceId), _roomId(roomId),
    _deviceType(deviceType), _hardwareTarget(hardwareTarget),
    _statusTopic(statusTopic) {}

void OtaClient::setPublicKey(const uint8_t publicKey[32]) {
  memcpy(_publicKey, publicKey, 32);
  _hasPublicKey = true;
}

void OtaClient::setCaCertificate(const char* rootCA) {
  _rootCA = rootCA;
}

void OtaClient::setCurrentSessionId(const String& sessionId) {
  if (_currentSessionId != sessionId) {
    _currentSessionId = sessionId;
    _lastSuccessPublishMs = 0;
  }
}

bool OtaClient::savePendingOta(const OtaCommand& command) {
  Preferences prefs;

  if (!prefs.begin("ota_state", false)) {
    return false;
  }

  bool ok = prefs.putString("job_id", command.jobId) > 0 &&
            prefs.putString("version", command.version) > 0 &&
            prefs.putBool("pending", true) > 0;

  if (!ok) {
    prefs.clear();
  }

  prefs.end();
  return ok;
}

void OtaClient::clearPendingOta() {
  Preferences prefs;

  if (!prefs.begin("ota_state", false)) {
    return;
  }

  prefs.clear();
  prefs.end();
}

bool OtaClient::publishPendingSuccess() {
  if (!_mqtt.connected() || _currentSessionId.isEmpty()) {
    return false;
  }

  if (time(nullptr) < 1700000000) {
    return false;
  }

  // Retry tối đa một lần mỗi 10 giây.
  uint32_t now = millis();

  if (_lastSuccessPublishMs != 0 &&
      now - _lastSuccessPublishMs < 10000) {
    return false;
  }

  Preferences prefs;

  if (!prefs.begin("ota_state", true)) {
    return false;
  }

  bool pending = prefs.getBool("pending", false);
  String jobId = prefs.getString("job_id", "");
  String expectedVersion = prefs.getString("version", "");

  prefs.end();

  if (!pending || jobId.isEmpty() || expectedVersion.isEmpty()) {
    return false;
  }

  // Đọc phiên bản thực tế của firmware đang chạy.
  const esp_app_desc_t* app = esp_app_get_description();

  if (app == nullptr) {
    return false;
  }

  String actualVersion = String(app->version);

  // Không báo SUCCESS nếu firmware thực tế không đúng phiên bản.
  if (actualVersion != expectedVersion) {
    Serial.printf(
      "[OTA] Version mismatch. Expected=%s, Actual=%s\n",
      expectedVersion.c_str(),
      actualVersion.c_str()
    );

    return false;
  }

  OtaStatus status;
  status.jobId = jobId;
  status.deviceId = _deviceId;
  status.roomId = _roomId;
  status.sessionId = _currentSessionId;
  status.version = actualVersion;
  status.status = "SUCCESS";
  status.progress = 100;

  String body = serializeOtaStatus(status);

  if (!_mqtt.publish(_statusTopic.c_str(), body.c_str(), false)) {
    return false;
  }

  // Không xóa NVS ở đây.
  // Chỉ xóa sau khi nhận ACK hợp lệ.
  _lastSuccessPublishMs = now;

  Serial.println("[OTA] SUCCESS published; waiting for backend ACK.");

  return true;
}

bool OtaClient::handleAck(
  const char* topic,
  const uint8_t* payload,
  size_t length
) {
  if (topic == nullptr ||
      String(topic).indexOf("/ota/ack") < 0) {
    return false;
  }

  OtaAck ack;

  if (!parseOtaAck(payload, length, ack)) {
    return false;
  }

  if (ack.deviceId != _deviceId ||
      ack.roomId != _roomId ||
      ack.sessionId != _currentSessionId ||
      ack.status != "SUCCESS") {
    return false;
  }

  Preferences prefs;

  if (!prefs.begin("ota_state", true)) {
    return false;
  }

  bool pending = prefs.getBool("pending", false);
  String jobId = prefs.getString("job_id", "");

  prefs.end();

  if (!pending || jobId.isEmpty() || ack.jobId != jobId) {
    return false;
  }

  clearPendingOta();
  _lastSuccessPublishMs = 0;

  Serial.println("[OTA] Backend ACK received. Pending state cleared.");

  return true;
}

void OtaClient::publishStatus(const OtaCommand& c, const String& state,
                              uint8_t progress, const String& message) {
  OtaStatus s;
  s.jobId = c.jobId;
  s.deviceId = _deviceId;
  s.roomId = _roomId;
  s.sessionId = c.sessionId;
  s.version = c.version;
  s.status = state;
  s.progress = progress;
  s.message = message;

  String body = serializeOtaStatus(s);
  _mqtt.publish(_statusTopic.c_str(), body.c_str(), false);
}

bool OtaClient::hexToBytes(const String& hex, uint8_t* output,
                           size_t outputLength) {
  if (hex.length() != outputLength * 2) return false;

  for (size_t i = 0; i < outputLength; i++) {
    char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    char* end = nullptr;
    long value = strtol(pair, &end, 16);
    if (end == pair || *end != '\0') return false;
    output[i] = (uint8_t)value;
  }
  return true;
}

bool OtaClient::base64ToBytes(const String& base64, uint8_t* output, size_t outputLength) {
  size_t decodedLength = 0;

  int result = mbedtls_base64_decode(
    output,
    outputLength,
    &decodedLength,
    reinterpret_cast<const unsigned char*>(base64.c_str()),
    base64.length()
  );

  return result == 0 && decodedLength == outputLength;
}

bool OtaClient::verifyDigest(const uint8_t digest[32], const String& signatureBase64) {
  if (!_hasPublicKey || signatureBase64.isEmpty()) return false;

  uint8_t signature[64];
  if (!base64ToBytes(signatureBase64, signature, sizeof(signature))) {
    return false;
  }
  // Monocypher: 0 means the Ed25519 signature is valid.
  return crypto_ed25519_check(signature, _publicKey, digest, 32) == 0;
}

bool OtaClient::validateCommand(const OtaCommand& c) {
  if (c.deviceId != _deviceId || c.roomId != _roomId) return false;

  if (c.deviceType != _deviceType ||
      c.hardwareTarget != _hardwareTarget) {
    return false;
  }

  if (c.sessionId != _currentSessionId ||
      _currentSessionId.isEmpty()) {
    return false;
  }

  if (!_hasPublicKey || _rootCA == nullptr) return false;
  if (WiFi.status() != WL_CONNECTED) return false;

  if (time(nullptr) < 1700000000) return false;

  uint64_t currentTimeMs = (uint64_t)time(nullptr) * 1000ULL;

  if (c.expiresAt == 0 || c.expiresAt <= currentTimeMs) {
    Serial.println("[OTA] Command expired or invalid.");
    return false;
  }

  return true;
}

bool OtaClient::handleCommand(const char* topic, const uint8_t* payload,
                              size_t length) {
  if (topic == nullptr || String(topic).indexOf("/ota/command") < 0) return false;

  OtaCommand command;
  if (!parseOtaCommand(payload, length, command)) return false;
  if (!validateCommand(command)) return false;

  publishStatus(command, "DOWNLOADING", 0, "OTA download started");

  if (!installFirmware(command)) {
    publishStatus(command, "FAILED", 0, "OTA installation failed");
    return false;
  }

  return true;
}

bool OtaClient::installFirmware(const OtaCommand& c) {
  WiFiClientSecure tls;
  tls.setCACert(_rootCA);

  HTTPClient http;
  http.setTimeout(30000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);

  if (!http.begin(tls, c.downloadUrl)) return false;

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    http.end();
    return false;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0 || (size_t)contentLength != c.fileSize) {
    http.end();
    return false;
  }

  if (!Update.begin(c.fileSize, U_FLASH)) {
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buffer[1024];
  size_t received = 0;
  bool writeOk = true;
  mbedtls_sha256_context sha;
  uint8_t digest[32];

  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  while (received < c.fileSize) {
    if (!stream->connected() && !stream->available()) {
      writeOk = false;
      break;
    }

    int available = stream->available();
    if (available <= 0) {
      delay(2);
      continue;
    }

    size_t remaining = c.fileSize - received;
    size_t count = min((size_t)available, min(sizeof(buffer), remaining));
    int readCount = stream->readBytes(buffer, count);

    if (readCount <= 0) {
      writeOk = false;
      break;
    }

   mbedtls_sha256_update(&sha, buffer, readCount);

    if (Update.write(buffer, readCount) != (size_t)readCount) {
      writeOk = false;
      break;
    }

    received += readCount;

    uint8_t progress = (uint8_t)((received * 100ULL) / c.fileSize);
    publishStatus(c, "DOWNLOADING", progress, "Downloading firmware");
    _mqtt.loop();
  }

 mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();

  if (!writeOk || received != c.fileSize) {
    Update.abort();
    return false;
  }

  publishStatus(c, "VERIFYING", 100, "Checking SHA-256 and Ed25519");

  uint8_t expectedDigest[32];
  if (!hexToBytes(c.sha256, expectedDigest, sizeof(expectedDigest)) ||
      memcmp(digest, expectedDigest, sizeof(digest)) != 0) {
    Update.abort();
    return false;
  }

  if (!verifyDigest(digest, c.signature)) {
    Update.abort();
    return false;
  }

  publishStatus(c, "INSTALLING", 100, "Firmware verified; finalizing update");

  if (!savePendingOta(c)) {
    Update.abort();
    return false;
  }

  if (!Update.end(true) || !Update.isFinished()) {
    clearPendingOta();
    Update.abort();
    return false;
  }

  publishStatus(c, "REBOOTING", 100, "Rebooting into new firmware");
  delay(1000);
  ESP.restart();
  return true;
}

bool OtaClient::confirmBoot() {
  const esp_partition_t* running = esp_ota_get_running_partition();

  if (running == nullptr) {
    Serial.println("[OTA] Cannot get running partition.");
    return false;
  }

  esp_ota_img_states_t state;

  esp_err_t stateResult = esp_ota_get_state_partition(running, &state);

  if (stateResult != ESP_OK) {
    Serial.printf("[OTA] Cannot get partition state: %s\n",
                  esp_err_to_name(stateResult));
    return false;
  }

  if (state == ESP_OTA_IMG_VALID) {
    return true;
  }

  if (state != ESP_OTA_IMG_PENDING_VERIFY) {
    Serial.printf("[OTA] Unexpected image state: %d\n", state);
    return false;
  }

  esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();

  if (result != ESP_OK) {
    Serial.printf("[OTA] Boot confirmation failed: %s\n",
                  esp_err_to_name(result));
    return false;
  }

  Serial.println("[OTA] New firmware confirmed. Rollback cancelled.");
  return true;
}

bool OtaClient::rollbackBoot(const String& reason) {
  const esp_partition_t* running = esp_ota_get_running_partition();

  if (running == nullptr) {
    Serial.println("[OTA] Cannot get running partition for rollback.");
    return false;
  }

  esp_ota_img_states_t state;

  esp_err_t stateResult = esp_ota_get_state_partition(running, &state);

  if (stateResult != ESP_OK) {
    Serial.printf(
      "[OTA] Cannot get partition state for rollback: %s\n",
      esp_err_to_name(stateResult)
    );
    return false;
  }

  if (state != ESP_OTA_IMG_PENDING_VERIFY) {
    Serial.printf(
      "[OTA] Rollback rejected: unexpected image state %d\n",
      state
    );
    return false;
  }

  Serial.printf(
    "[OTA] New firmware health check failed: %s\n",
    reason.c_str()
  );

  Serial.println("[OTA] Marking firmware invalid and requesting rollback.");

  esp_err_t result = esp_ota_mark_app_invalid_rollback_and_reboot();

  if (result != ESP_OK) {
    Serial.printf(
      "[OTA] Rollback failed: %s\n",
      esp_err_to_name(result)
    );
    return false;
  }

  return true;
}