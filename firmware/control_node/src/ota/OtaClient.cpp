#include "OtaClient.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <esp_ota_ops.h>
#include "monocypher-ed25519.h"
#include <mbedtls/base64.h>
#include <Preferences.h>
#include <nvs_flash.h>
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
    Serial.println("[OTA] NVS ota_state mo that bai, dang format NVS partition...");
    nvs_flash_erase();
    nvs_flash_init();
    if (!prefs.begin("ota_state", false)) {
      Serial.println("[OTA] Canh bao: Khong the mo NVS ota_state.");
    }
  }

  String prevVer = "1.0.0";
  const esp_app_desc_t* currentApp = esp_app_get_description();
  if (currentApp != nullptr && currentApp->version[0] != '\0') {
    prevVer = String(currentApp->version);
  }

  prefs.putString("job_id", command.jobId);
  prefs.putString("version", command.version);
  prefs.putString("previous_version", prevVer);
  prefs.putBool("pending", true);
  prefs.end();

  Serial.printf("[OTA] Da luu thong tin OTA pending: Job=%s, Target=%s\n",
                command.jobId.c_str(), command.version.c_str());
  return true;
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

  uint32_t now = millis();

  if (_lastSuccessPublishMs != 0 &&
      now - _lastSuccessPublishMs < 5000) {
    return false;
  }

  Preferences prefs;

  if (!prefs.begin("ota_state", true)) {
    return false;
  }

  bool pending = prefs.getBool("pending", false);
  String jobId = prefs.getString("job_id", "");
  String expectedVersion = prefs.getString("version", "");
  String previousVersion = prefs.getString("previous_version", "");

  prefs.end();

  if (!pending || jobId.isEmpty() || expectedVersion.isEmpty()) {
    return false;
  }

  // Xac nhan boot partition moi hop le de khong bi rollback
  confirmBoot();

  OtaStatus status;
  status.jobId = jobId;
  status.deviceId = _deviceId;
  status.roomId = _roomId;
  status.sessionId = _currentSessionId;
  status.version = expectedVersion;
  status.status = "SUCCESS";
  status.progress = 100;
  status.message = "Firmware updated successfully";

  Serial.printf("[OTA] Da boot vao Firmware moi! Dang bao cao SUCCESS ve Server (Job=%s, Version=%s)...\n",
                jobId.c_str(), expectedVersion.c_str());

  String body = serializeOtaStatus(status);

  if (!_mqtt.publish(_statusTopic.c_str(), body.c_str(), false)) {
    Serial.println("[OTA] Gui ban tin SUCCESS that bai!");
    return false;
  }

  _lastSuccessPublishMs = now;

  Serial.println("[OTA] ========================================================");
  Serial.printf("[OTA] CAP NHAT OTA THANH CONG! Cho Server ACK (Phien ban: %s)...\n", expectedVersion.c_str());
  Serial.println("[OTA] ========================================================");

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
      ack.result != "PROCESSED" ||
      (ack.status != "SUCCESS" &&
       ack.status != "ROLLED_BACK")) {
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

  Serial.printf(
    "[OTA] Backend ACK received. Status=%s. Pending state cleared.\n",
    ack.status.c_str()
  );

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

  if (result != 0 || decodedLength != outputLength) {
    Serial.printf("[OTA] base64ToBytes loi: result=%d, decodedLength=%u, expected=%u\n",
                  result, (unsigned int)decodedLength, (unsigned int)outputLength);
    return false;
  }
  return true;
}

bool OtaClient::verifyDigest(const uint8_t digest[32], const String& signatureBase64) {
  if (!_hasPublicKey) {
    Serial.println("[OTA] verifyDigest loi: Chua cau hinh Public Key!");
    return false;
  }
  if (signatureBase64.isEmpty()) {
    Serial.println("[OTA] verifyDigest loi: Chu ky signature bi rong!");
    return false;
  }

  uint8_t signature[64];
  if (!base64ToBytes(signatureBase64, signature, sizeof(signature))) {
    Serial.println("[OTA] verifyDigest loi: Decode base64 chu ky that bai!");
    return false;
  }

  // Monocypher: 0 means the Ed25519 signature is valid.
  int checkResult = crypto_ed25519_check(signature, _publicKey, digest, 32);
  Serial.printf("[OTA] Ket qua xac thuc Ed25519: %d (0 la HOP LE)\n", checkResult);
  return checkResult == 0;
}

bool OtaClient::validateCommand(const OtaCommand& c) {
  if (c.deviceId != _deviceId || c.roomId != _roomId) {
    Serial.printf("[OTA] Device/Room mismatch: %s/%s vs %s/%s\n", c.deviceId.c_str(), c.roomId.c_str(), _deviceId.c_str(), _roomId.c_str());
    return false;
  }

  if (c.deviceType != _deviceType) {
    Serial.printf("[OTA] Device type mismatch: %s vs %s\n", c.deviceType.c_str(), _deviceType.c_str());
    return false;
  }

  if (c.hardwareTarget != _hardwareTarget && c.hardwareTarget != "ESP32_SensorNode" && c.hardwareTarget != "ESP32") {
    Serial.printf("[OTA] Hardware target mismatch: %s vs %s\n", c.hardwareTarget.c_str(), _hardwareTarget.c_str());
    return false;
  }

  if (c.sessionId != _currentSessionId || _currentSessionId.isEmpty()) {
    Serial.printf("[OTA] Session ID mismatch: command=%s vs current=%s\n", c.sessionId.c_str(), _currentSessionId.c_str());
    return false;
  }

  if (!_hasPublicKey) {
    Serial.println("[OTA] No public key configured");
    return false;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[OTA] Wi-Fi not connected");
    return false;
  }

  uint64_t currentTimeMs = (uint64_t)time(nullptr) * 1000ULL;
  if (c.expiresAt > 0 && c.expiresAt <= currentTimeMs) {
    Serial.println("[OTA] Command expired.");
    return false;
  }

  return true;
}

bool OtaClient::handleCommand(const char* topic, const uint8_t* payload,
                              size_t length) {
  if (topic == nullptr || String(topic).indexOf("/ota/command") < 0) return false;

  Serial.println("\n[OTA] Nhan duoc ban tin OTA Command tu Server!");

  OtaCommand command;
  if (!parseOtaCommand(payload, length, command)) {
    Serial.println("[OTA] Loi parse JSON cua OTA Command (kiem tra URL hoac format)");
    return false;
  }
  if (!validateCommand(command)) {
    Serial.println("[OTA] Kiem tra tinh hop le cua Command that bai!");
    return false;
  }

  Serial.printf("[OTA] Xac thuc thanh cong! Bat dau tai firmware: %s (%u bytes)...\n", command.version.c_str(), (unsigned int)command.fileSize);
  publishStatus(command, "DOWNLOADING", 0, "OTA download started");

  if (!installFirmware(command)) {
    Serial.println("[OTA] Cai dat firmware that bai!");
    delay(200);
    publishStatus(command, "FAILED", 0, "OTA installation failed");
    return false;
  }

  return true;
}

bool OtaClient::installFirmware(const OtaCommand& c) {
  HTTPClient http;
  http.setTimeout(30000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);

  WiFiClient client;
  WiFiClientSecure* tls = nullptr;

  bool beginOk = false;
  if (c.downloadUrl.startsWith("https://")) {
    tls = new WiFiClientSecure();
    if (_rootCA && strlen(_rootCA) > 0) {
      tls->setCACert(_rootCA);
    } else {
      tls->setInsecure();
    }
    beginOk = http.begin(*tls, c.downloadUrl);
  } else {
    beginOk = http.begin(client, c.downloadUrl);
  }

  if (!beginOk) {
    Serial.println("[OTA] HTTP begin that bai!");
    if (tls) delete tls;
    return false;
  }

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[OTA] HTTP GET failed, code: %d (URL: %s)\n", httpCode, c.downloadUrl.c_str());
    http.end();
    if (tls) delete tls;
    return false;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0 || (size_t)contentLength != c.fileSize) {
    Serial.printf("[OTA] Size mismatch: content=%d vs expected=%u\n", contentLength, (unsigned int)c.fileSize);
    http.end();
    if (tls) delete tls;
    return false;
  }

  if (!Update.begin(c.fileSize, U_FLASH)) {
    Serial.println("[OTA] Update.begin failed! Partition may be too small or partition scheme not set to OTA.");
    http.end();
    if (tls) delete tls;
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t* buffer = (uint8_t*)malloc(1024);
  if (!buffer) {
    Serial.println("[OTA] Khong du RAM de cap phat buffer 1024 bytes!");
    Update.abort();
    http.end();
    if (tls) delete tls;
    return false;
  }

  size_t received = 0;
  bool writeOk = true;
  mbedtls_sha256_context sha;
  uint8_t digest[32];

  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  uint8_t lastReportedProgress = 0;

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
    size_t count = min((size_t)available, min((size_t)1024, remaining));
    int readCount = stream->readBytes(buffer, count);

    if (readCount <= 0) {
      writeOk = false;
      break;
    }

    mbedtls_sha256_update(&sha, buffer, readCount);

    if (Update.write(buffer, readCount) != (size_t)readCount) {
      Serial.printf("[OTA] Update.write loi tai vi tri: %u\n", (unsigned int)received);
      writeOk = false;
      break;
    }

    received += readCount;

    uint8_t progress = (uint8_t)((received * 100ULL) / c.fileSize);
    if (progress >= lastReportedProgress + 10 || progress == 100) {
      lastReportedProgress = progress;
      publishStatus(c, "DOWNLOADING", progress, "Downloading firmware");
      Serial.printf("[OTA] Dang tai: %u%% (%u/%u bytes)\n", progress, (unsigned int)received, (unsigned int)c.fileSize);
      _mqtt.loop();
    }
  }

  free(buffer);
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();
  if (tls) delete tls;

  if (!writeOk || received != c.fileSize) {
    Serial.printf("[OTA] Ghi flash that bai! received=%u vs expected=%u\n", (unsigned int)received, (unsigned int)c.fileSize);
    Update.abort();
    return false;
  }

  Serial.println("[OTA] Tai firmware thanh cong 100%! Dang kiem tra SHA-256 va Ed25519...");
  publishStatus(c, "VERIFYING", 100, "Checking SHA-256 and Ed25519");

  // In ra mã SHA-256 tính toán và mong đợi
  Serial.print("[OTA] SHA-256 thuc te : ");
  for (int i = 0; i < 32; i++) Serial.printf("%02x", digest[i]);
  Serial.println();
  Serial.printf("[OTA] SHA-256 mong doi: %s\n", c.sha256.c_str());

  uint8_t expectedDigest[32];
  if (!hexToBytes(c.sha256, expectedDigest, sizeof(expectedDigest))) {
    Serial.println("[OTA] Loi: Khong the parse chuoi SHA-256 hex!");
    Update.abort();
    return false;
  }

  if (memcmp(digest, expectedDigest, sizeof(digest)) != 0) {
    Serial.println("[OTA] Loi: SHA-256 KHONG KHOP!");
    Update.abort();
    return false;
  }
  Serial.println("[OTA] SHA-256 KHOP 100%! Dang xac minh chu ky Ed25519...");

  if (!verifyDigest(digest, c.signature)) {
    Serial.println("[OTA] Loi: Chu ky Ed25519 KHONG HOP LE!");
    Update.abort();
    return false;
  }
  Serial.println("[OTA] Chu ky Ed25519 HOP LE 100%! Dang hoan tat ghi vao Flash...");

  publishStatus(c, "INSTALLING", 100, "Firmware verified; finalizing update");

  if (!savePendingOta(c)) {
    Serial.println("[OTA] Loi luu trang thai OTA pending vao NVS!");
    Update.abort();
    return false;
  }
  Serial.println("[OTA] Da luu trang thai OTA vao NVS.");

  if (!Update.end(true)) {
    Serial.printf("[OTA] Update.end(true) that bai! Error code: %d\n", Update.getError());
    clearPendingOta();
    Update.abort();
    return false;
  }

  if (!Update.isFinished()) {
    Serial.println("[OTA] Update chua hoan tat!");
    clearPendingOta();
    Update.abort();
    return false;
  }

  Serial.println("\n[OTA] ========================================");
  Serial.println("[OTA] NHOI FIRMWARE VAO PHAN VUNG MOI THANH CONG!");
  Serial.println("[OTA] KHOI DONG LAI VAO FIRMWARE MOI TRONG 1S...");
  Serial.println("[OTA] ========================================\n");

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