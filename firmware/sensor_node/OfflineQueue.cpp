#include "OfflineQueue.h"
#include <ArduinoJson.h>

OfflineQueue::OfflineQueue(fs::FS& filesystem, size_t maxRecords)
  : fs(filesystem), capacity(maxRecords) {}

String OfflineQueue::lastError() const { return errorMessage; }

bool OfflineQueue::begin() {
  errorMessage = "";
  if (capacity == 0) {
    errorMessage = "Dung luong hang doi phai lon hon 0";
    return false;
  }
  if (!recoverFiles()) return false;
  return repairTrailingRecord();
}

bool OfflineQueue::recoverFiles() {
  auto isUsableQueue = [&](const char* path, bool allowIncompleteTail) -> bool {
    if (!fs.exists(path)) return false;

    File file = fs.open(path, FILE_READ);
    if (!file) return false;

    const size_t fileSize = file.size();
    bool endsWithNewline = true;

    if (fileSize > 0) {
      if (!file.seek(fileSize - 1)) {
        file.close();
        return false;
      }

      endsWithNewline = file.read() == '\n';

      if (!file.seek(0)) {
        file.close();
        return false;
      }
    }

    bool valid = true;

    while (file.available()) {
      String line = file.readStringUntil('\n');
      line.trim();

      if (line.isEmpty()) continue;

      if (!validateRecord(line)) {
        const bool finalLine = !file.available();

        if (allowIncompleteTail &&
            finalLine &&
            !endsWithNewline) {
          errorMessage = "";
          break;
        }

        valid = false;
        break;
      }
    }

    file.close();
    errorMessage = "";

    return valid;
  };

  const bool mainExists = fs.exists(queuePath);
  const bool backupExists = fs.exists(backupPath);
  const bool tempExists = fs.exists(tempPath);

  // 1. Ưu tiên queue chính nếu tất cả bản ghi đều hợp lệ.
  if (isUsableQueue(queuePath, false)) {
    if (tempExists && !fs.remove(tempPath)) {
      errorMessage = "Khong xoa duoc file tam";
      return false;
    }

    if (backupExists && !fs.remove(backupPath)) {
      errorMessage = "Khong xoa duoc file backup";
      return false;
    }

    return true;
  }

  // 2. Queue chính hỏng: ưu tiên backup.
  if (isUsableQueue(backupPath, false)) {
    if (mainExists && !fs.remove(queuePath)) {
      errorMessage = "Khong xoa duoc queue hong";
      return false;
    }

    if (!fs.rename(backupPath, queuePath)) {
      errorMessage = "Khong khoi phuc duoc backup";
      return false;
    }

    if (tempExists && !fs.remove(tempPath)) {
      errorMessage = "Khong xoa duoc file tam";
      return false;
    }

    return true;
  }

  // 3. Chỉ sử dụng file tạm nếu main và backup không hợp lệ.
  if (isUsableQueue(tempPath, false)) {
    if (mainExists && !fs.remove(queuePath)) {
      errorMessage = "Khong xoa duoc queue hong";
      return false;
    }

    if (!fs.rename(tempPath, queuePath)) {
      errorMessage = "Khong khoi phuc duoc file tam";
      return false;
    }

    if (backupExists && !fs.remove(backupPath)) {
      errorMessage = "Khong xoa duoc backup cu";
      return false;
    }

    return true;
  }

  // 4. Nếu chỉ còn queue chính với dòng cuối ghi dở,
  // giữ lại để repairTrailingRecord() xử lý.
  if (mainExists && isUsableQueue(queuePath, true)) {
    return true;
  }

  // 5. Không tự tạo queue mới khi còn file dữ liệu bị lỗi.
  if (mainExists || backupExists || tempExists) {
    errorMessage = "Tat ca file queue deu hong, tu choi khoi tao lai";
    return false;
  }

  // 6. Chỉ tạo mới khi chưa từng có dữ liệu.
  File file = fs.open(queuePath, FILE_WRITE);

  if (!file) {
    errorMessage = "Khong tao duoc file hang doi";
    return false;
  }

  file.close();
  errorMessage = "";

  return true;
}

bool OfflineQueue::repairTrailingRecord() {
  File source = fs.open(queuePath, FILE_READ);
  if (!source) {
    errorMessage = "Khong doc duoc queue de phuc hoi";
    return false;
  }

  const size_t originalSize = source.size();
  if (originalSize == 0) {
    source.close();
    return true;
  }

  if (!source.seek(originalSize - 1)) {
    source.close();
    errorMessage = "Khong kiem tra duoc cuoi file queue";
    return false;
  }

  const int lastByte = source.read();
  source.close();

  if (lastByte == '\n') return true;

  source = fs.open(queuePath, FILE_READ);
  if (!source) {
    errorMessage = "Khong mo lai duoc queue";
    return false;
  }

  if (fs.exists(tempPath)) fs.remove(tempPath);

  File target = fs.open(tempPath, FILE_WRITE);
  if (!target) {
    source.close();
    errorMessage = "Khong tao duoc file phuc hoi";
    return false;
  }

  bool ok = true;
  size_t expectedSize = 0;

  while (source.available()) {
    String line = source.readStringUntil('\n');
    const bool isLastLine = !source.available();
    line.trim();

    if (line.isEmpty()) continue;

    if (!validateRecord(line)) {
      // Chỉ được bỏ dòng cuối nếu nó bị ghi dở.
      if (isLastLine) {
        errorMessage = "";
        break;
      }

      ok = false;
      break;
    }

    const size_t written = target.println(line);
    if (written != line.length() + 2) {
      ok = false;
      break;
    }

    expectedSize += written;
  }

  target.flush();
  target.close();
  source.close();

  if (!ok) {
    fs.remove(tempPath);
    errorMessage = "Queue co ban ghi loi khong nam o cuoi file";
    return false;
  }

  File check = fs.open(tempPath, FILE_READ);
  if (!check || check.size() != expectedSize) {
    if (check) check.close();
    fs.remove(tempPath);
    errorMessage = "Kiem tra file phuc hoi that bai";
    return false;
  }
  check.close();

  if (fs.exists(backupPath)) fs.remove(backupPath);

  if (!fs.rename(queuePath, backupPath)) {
    fs.remove(tempPath);
    errorMessage = "Khong backup duoc queue";
    return false;
  }

  if (!fs.rename(tempPath, queuePath)) {
    fs.rename(backupPath, queuePath);
    errorMessage = "Khong thay the duoc queue";
    return false;
  }

  fs.remove(backupPath);
  errorMessage = "";
  return true;
}

bool OfflineQueue::validateRecord(
  const String& json,
  String* messageId
) {
  StaticJsonDocument<2048> doc;

  DeserializationError err = deserializeJson(doc, json);

  if (err || !doc.is<JsonObject>()) {
    errorMessage = "Ban ghi JSON khong hop le";
    return false;
  }

  auto validIdentifier = [](const char* value) -> bool {
    if (!value || !*value || strlen(value) > 40) {
      return false;
    }

    for (size_t i = 0; value[i] != '\0'; ++i) {
      const char c = value[i];

      if (!((c >= 'A' && c <= 'Z') ||
            (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') ||
            c == '_' || c == '-')) {
        return false;
      }
    }

    return true;
  };

  const bool isCanonical = doc.containsKey("msg_id");
  const bool isLegacy = doc.containsKey("eventId");

  // Không chấp nhận thiếu hoặc trộn hai định dạng.
  if (isCanonical == isLegacy) {
    errorMessage = "Payload thieu hoac trung dinh dang";
    return false;
  }

  const char* id = nullptr;

  if (isCanonical) {
    // Payload chuẩn không được chứa trường legacy.
    if (doc.containsKey("messageType") ||
        doc.containsKey("deviceId") ||
        doc.containsKey("roomCode") ||
        doc.size() != 5) {
      errorMessage = "Payload chuan chua truong khong hop le";
      return false;
    }

    if (!doc["msg_id"].is<const char*>() ||
        !doc["device_id"].is<const char*>() ||
        !doc["room_id"].is<const char*>() ||
        !doc["timestamp"].is<uint64_t>() ||
        !doc["data"].is<JsonObject>()) {
      errorMessage = "Payload chuan sai kieu du lieu";
      return false;
    }

    id = doc["msg_id"];

    if (!validIdentifier(doc["device_id"]) ||
        !validIdentifier(doc["room_id"]) ||
        !id || !*id || strlen(id) > 64) {
      errorMessage = "Payload chuan sai dinh danh";
      return false;
    }

    const uint64_t timestamp = doc["timestamp"].as<uint64_t>();

    if (timestamp > 8640000000000000ULL) {
      errorMessage = "Timestamp vuot gioi han";
      return false;
    }

    JsonObject data = doc["data"];

    if (data.size() != 4 ||
        !data["temperature"].is<float>() ||
        !data["humidity"].is<float>() ||
        !data["lux"].is<uint16_t>() ||
        !data["occupancy"].is<bool>()) {
      errorMessage = "Du lieu telemetry chuan sai cau truc";
      return false;
    }

    const float temperature = data["temperature"].as<float>();
    const float humidity = data["humidity"].as<float>();
    const uint16_t lux = data["lux"].as<uint16_t>();

    if (!isfinite(temperature) ||
        temperature < -10.0f ||
        temperature > 60.0f ||
        !isfinite(humidity) ||
        humidity < 0.0f ||
        humidity > 100.0f ||
        lux > 65535) {
      errorMessage = "Gia tri telemetry chuan vuot gioi han";
      return false;
    }

  } else {
    // Payload legacy không được chứa trường chuẩn.
    if (doc.containsKey("msg_id") ||
        doc.containsKey("device_id") ||
        doc.containsKey("room_id") ||
        doc.containsKey("data") ||
        doc.size() < 7 ||
        doc.size() > 8) {
      errorMessage = "Payload legacy chua truong khong hop le";
      return false;
    }

    if (!doc["messageType"].is<const char*>() ||
        !doc["eventId"].is<const char*>() ||
        !doc["deviceId"].is<const char*>() ||
        !doc["roomCode"].is<const char*>() ||
        !doc["temperatureC"].is<float>() ||
        !doc["humidityPercent"].is<float>() ||
        !doc["illuminanceLux"].is<float>()) {
      errorMessage = "Payload legacy sai kieu du lieu";
      return false;
    }

    if (String(doc["messageType"].as<const char*>()) != "telemetry") {
      errorMessage = "messageType legacy khong hop le";
      return false;
    }

    id = doc["eventId"];

    if (!id || !*id || strlen(id) > 64 ||
        !validIdentifier(doc["deviceId"]) ||
        !validIdentifier(doc["roomCode"])) {
      errorMessage = "Payload legacy sai dinh danh";
      return false;
    }

    const float temperature = doc["temperatureC"].as<float>();
    const float humidity = doc["humidityPercent"].as<float>();
    const float lux = doc["illuminanceLux"].as<float>();

    if (!isfinite(temperature) ||
        temperature < -10.0f ||
        temperature > 60.0f ||
        !isfinite(humidity) ||
        humidity < 0.0f ||
        humidity > 100.0f ||
        !isfinite(lux) ||
        lux < 0.0f ||
        lux > 65535.0f) {
      errorMessage = "Gia tri telemetry legacy vuot gioi han";
      return false;
    }

    if (doc.containsKey("occupancy") &&
        !doc["occupancy"].is<bool>()) {
      errorMessage = "Occupancy legacy sai kieu du lieu";
      return false;
    }

    if (doc.containsKey("timestamp") &&
        !doc["timestamp"].is<const char*>()) {
      errorMessage = "Timestamp legacy sai kieu du lieu";
      return false;
    }
  }

  if (messageId) {
    *messageId = String(id);
  }

  errorMessage = "";
  return true;
}

size_t OfflineQueue::count() {
  errorMessage = "";
  File file = fs.open(queuePath, FILE_READ);
  if (!file) {
    errorMessage = "Khong doc duoc hang doi";
    return 0;
  }

  size_t total = 0;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;

    if (!validateRecord(line)) {
      file.close();
      return 0;
    }
    ++total;
  }

  file.close();
  return total;
}

bool OfflineQueue::isFull() {
  const size_t current = count();
  if (!errorMessage.isEmpty()) return true;
  return current >= capacity;
}

bool OfflineQueue::enqueue(const String& jsonRecord) {
  errorMessage = "";
  String incomingId;
  if (!validateRecord(jsonRecord, &incomingId)) return false;

  const size_t current = count();
  if (!errorMessage.isEmpty()) return false;
  if (current >= capacity) {
    errorMessage = "Hang doi day; khong ghi de du lieu cu";
    return false;
  }

  File reader = fs.open(queuePath, FILE_READ);
  if (!reader) {
    errorMessage = "Khong doc duoc hang doi";
    return false;
  }

  while (reader.available()) {
    String line = reader.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;

    String existingId;
    if (!validateRecord(line, &existingId)) {
      reader.close();
      return false;
    }
    if (existingId == incomingId) {
      reader.close();
      errorMessage = "msg_id da ton tai trong hang doi";
      return false;
    }
  }
  reader.close();

  File writer = fs.open(queuePath, FILE_APPEND);
  if (!writer) {
    errorMessage = "Khong mo duoc file de ghi";
    return false;
  }

  const size_t written = writer.println(jsonRecord);
  writer.flush();
  writer.close();

  if (written != jsonRecord.length() + 2) {
    errorMessage = "Ghi telemetry khong day du";
    return false;
  }

  return true;
}

bool OfflineQueue::peek(String& jsonRecord) {
  errorMessage = "";
  File file = fs.open(queuePath, FILE_READ);
  if (!file) {
    errorMessage = "Khong doc duoc hang doi";
    return false;
  }

  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;

    if (!validateRecord(line)) {
      file.close();
      return false;
    }

    jsonRecord = line;
    file.close();
    return true;
  }

  file.close();
  return false;
}

bool OfflineQueue::rewriteWithoutMessage(const String& messageId) {
  errorMessage = "";

  File source = fs.open(queuePath, FILE_READ);

  if (!source) {
    errorMessage = "Khong doc duoc hang doi goc";
    return false;
  }

  if (fs.exists(tempPath)) {
    fs.remove(tempPath);
  }

  File target = fs.open(tempPath, FILE_WRITE);

  if (!target) {
    source.close();
    errorMessage = "Khong tao duoc file tam";
    return false;
  }

  bool found = false;
  bool ok = true;
  size_t expectedSize = 0;

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.isEmpty()) continue;

    String currentId;

    if (!validateRecord(line, &currentId)) {
      ok = false;
      break;
    }

    if (currentId == messageId) {
      found = true;
      continue;
    }

    const size_t written = target.println(line);

    if (written != line.length() + 2) {
      ok = false;
      break;
    }

    expectedSize += written;
  }

  target.flush();
  target.close();
  source.close();

  if (!ok || !found) {
    fs.remove(tempPath);

    errorMessage = !ok
      ? "Hang doi loi hoac ghi file tam that bai"
      : "Khong tim thay msg_id can xac nhan";

    return false;
  }

  // Kiểm tra kích thước file tạm trước khi thay thế.
  File check = fs.open(tempPath, FILE_READ);

  if (!check || check.size() != expectedSize) {
    if (check) check.close();

    fs.remove(tempPath);
    errorMessage = "Kiem tra file tam that bai";

    return false;
  }

  check.close();

  // Backup queue hiện tại.
  if (fs.exists(backupPath)) {
    fs.remove(backupPath);
  }

  if (!fs.rename(queuePath, backupPath)) {
    fs.remove(tempPath);
    errorMessage = "Khong tao duoc backup";
    return false;
  }

  // Đưa file tạm thành queue chính.
  if (!fs.rename(tempPath, queuePath)) {
    if (!fs.rename(backupPath, queuePath)) {
      errorMessage = "Khong thay the duoc queue va khong khoi phuc duoc backup";
    } else {
      errorMessage = "Khong thay the duoc hang doi";
    }

    fs.remove(tempPath);
    return false;
  }

  // Chỉ xóa backup sau khi queue mới đã thay thế thành công.
  fs.remove(backupPath);

  errorMessage = "";
  return true;
}

bool OfflineQueue::acknowledge(const String& messageId) {
  errorMessage = "";
  if (messageId.isEmpty()) {
    errorMessage = "msg_id ACK rong";
    return false;
  }

  // Chỉ cho phép xóa bản ghi đầu hàng đợi.
  // ACK cũ hoặc ACK cho bản tin khác không được làm mất dữ liệu.
  String firstRecord;
  if (!peek(firstRecord)) {
    if (errorMessage.isEmpty()) errorMessage = "Hang doi rong";
    return false;
  }

  String firstId;
  if (!validateRecord(firstRecord, &firstId)) return false;
  if (firstId != messageId) {
    errorMessage = "ACK khong khop ban ghi dau hang doi";
    return false;
  }

  return rewriteWithoutMessage(messageId);
}