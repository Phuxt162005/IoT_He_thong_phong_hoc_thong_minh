#include "OfflineQueue.h"
#include <ArduinoJson.h>
#include <math.h>
#include <string.h>

  const char* queuePath = "/telemetry_queue.jsonl";
  const char* tempPath = "/telemetry_queue.tmp";
  const char* backupPath = "/telemetry_queue.bak";
  const char* corruptPath = "/telemetry_queue.corrupt";

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
  auto isUsableQueue = [&](const char* path) -> bool {
    if (!fs.exists(path)) return false;

    File file = fs.open(path, FILE_READ);
    if (!file) return false;

    bool valid = true;

    while (file.available()) {
      String line = file.readStringUntil('\n');
      line.trim();

      if (line.isEmpty()) continue;

      if (!validateRecord(line)) {
        valid = false;
        break;
      }
    }

    file.close();
    errorMessage = "";
    return valid;
  };

  bool mainExists = fs.exists(queuePath);
  bool backupExists = fs.exists(backupPath);
  bool tempExists = fs.exists(tempPath);

  const bool mainValid = mainExists && isUsableQueue(queuePath);
  const bool backupValid = backupExists && isUsableQueue(backupPath);
  const bool tempValid = tempExists && isUsableQueue(tempPath);

  // 1. Queue chính hợp lệ: đây là trạng thái đã commit.
  if (mainValid) {
    if (tempExists && !fs.remove(tempPath)) {
      errorMessage = "Khong xoa duoc file tam";
      return false;
    }

    if (backupExists && !fs.remove(backupPath)) {
      errorMessage = "Queue chinh hop le nhung khong xoa duoc backup";
      return false;
    }

    errorMessage = "";
    return true;
  }

  // 2. Queue chính lỗi, backup hợp lệ.
  // Giữ nguyên queue lỗi trước khi khôi phục backup.
  if (backupValid) {
    if (mainExists) {
      if (fs.exists(corruptPath)) {
        errorMessage = "File corrupt da ton tai; khong ghi de du lieu";
        return false;
      }

      if (!fs.rename(queuePath, corruptPath)) {
        errorMessage = "Khong the bao toan queue hong";
        return false;
      }
    }

    if (!fs.rename(backupPath, queuePath)) {
      // Thử đưa queue lỗi trở lại vị trí cũ nếu khôi phục thất bại.
      if (fs.exists(corruptPath) && !fs.exists(queuePath)) {
        fs.rename(corruptPath, queuePath);
      }

      errorMessage = "Khong khoi phuc duoc backup";
      return false;
    }

    if (!isUsableQueue(queuePath)) {
      errorMessage = "Queue backup sau phuc hoi khong hop le";
      return false;
    }

    // File tạm là kết quả viết lại chưa commit.
    // Backup cũ đã được phục hồi nên có thể bỏ file tạm.
    if (tempExists && !fs.remove(tempPath)) {
      errorMessage = "Phuc hoi backup thanh cong nhung khong xoa duoc temp";
      return false;
    }

    errorMessage = "";
    return true;
  }

  // 3. Không có backup hợp lệ nhưng temp hợp lệ.
  if (!mainExists && tempValid) {
    if (!fs.rename(tempPath, queuePath)) {
      errorMessage = "Khong khoi phuc duoc file tam";
      return false;
    }

    if (!isUsableQueue(queuePath)) {
      errorMessage = "File tam sau phuc hoi khong hop le";
      return false;
    }

    errorMessage = "";
    return true;
  }

  // 4. Main lỗi, không có backup hợp lệ, temp hợp lệ.
  // Bảo toàn main lỗi trước khi dùng temp.
  if (mainExists && !mainValid && tempValid) {
    if (fs.exists(corruptPath)) {
      errorMessage = "File corrupt da ton tai; khong ghi de du lieu";
      return false;
    }

    if (!fs.rename(queuePath, corruptPath)) {
      errorMessage = "Khong the bao toan queue hong";
      return false;
    }

    if (!fs.rename(tempPath, queuePath)) {
      fs.rename(corruptPath, queuePath);
      errorMessage = "Khong khoi phuc duoc file tam";
      return false;
    }

    if (!isUsableQueue(queuePath)) {
      errorMessage = "Queue phuc hoi tu temp khong hop le";
      return false;
    }

    errorMessage = "";
    return true;
  }

  // 5. Có file dữ liệu nhưng không có bản hợp lệ.
  // Không tự tạo queue mới vì có thể che giấu dữ liệu bị lỗi.
  if (mainExists || backupExists || tempExists) {
    errorMessage =
      "Khong co queue hop le; giu nguyen cac file de bao toan du lieu";
    return false;
  }

  // 6. Chỉ tạo queue mới khi chưa có dữ liệu nào.
  File file = fs.open(queuePath, FILE_WRITE);

  if (!file) {
    errorMessage = "Khong tao duoc file hang doi";
    return false;
  }

  file.flush();
  file.close();

  File verify = fs.open(queuePath, FILE_READ);

  if (!verify) {
    errorMessage = "Khong kiem tra duoc queue moi";
    return false;
  }

  const bool empty = verify.size() == 0;
  verify.close();

  if (!empty) {
    errorMessage = "Queue moi khong rong bat thuong";
    return false;
  }

  errorMessage = "";
  return true;
}

bool OfflineQueue::repairTrailingRecord() {
  errorMessage = "";

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

  if (lastByte < 0) {
    source.close();
    errorMessage = "Khong doc duoc byte cuoi queue";
    return false;
  }

  if (lastByte == '\n') {
    source.close();
    return true;
  }

  // Đọc lại dòng cuối. Không được tự ý loại bỏ dòng không hợp lệ.
  if (!source.seek(0)) {
    source.close();
    errorMessage = "Khong dua con tro queue ve dau file";
    return false;
  }

  String lastLine;
  while (source.available()) {
    lastLine = source.readStringUntil('\n');
  }

  source.close();
  lastLine.trim();

  if (lastLine.isEmpty() || !validateRecord(lastLine)) {
    errorMessage =
      "Dong cuoi queue khong hop le; giu nguyen file de bao toan du lieu";
    return false;
  }

  // Dòng cuối hợp lệ nhưng thiếu newline: chỉ bổ sung newline.
  File appendFile = fs.open(queuePath, FILE_APPEND);

  if (!appendFile) {
    errorMessage = "Khong mo duoc queue de bo sung newline";
    return false;
  }

  const size_t written = appendFile.print('\n');
  appendFile.flush();
  appendFile.close();

  if (written != 1) {
    errorMessage = "Khong ghi duoc newline cuoi queue";
    return false;
  }

  // Xác minh lại byte cuối sau khi ghi.
  File verify = fs.open(queuePath, FILE_READ);

  if (!verify) {
    errorMessage = "Khong mo duoc queue de xac minh";
    return false;
  }

  const size_t newSize = verify.size();
  bool validEnding = false;

  if (newSize == originalSize + 1 &&
      verify.seek(newSize - 1)) {
    validEnding = verify.read() == '\n';
  }

  verify.close();

  if (!validEnding) {
    errorMessage = "Xac minh newline sau phuc hoi that bai";
    return false;
  }

  errorMessage = "";
  return true;
}

static bool isValidIdentifierValue(const char* value) {
  if (!value || !*value || strlen(value) > 40) return false;

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
}

// Chấp nhận chuỗi rỗng hoặc ISO-8601 có timezone.
// Ví dụ: 2026-11-09T10:30:00Z, 2026-11-09T10:30:00.123+07:00

static bool isValidLegacyTimestamp(const char* value) {
  if (!value) return false;
  if (*value == '\0') return true;

  const size_t len = strlen(value);
  if (len < 20 || len > 35) return false;

  auto digit = [](char c) -> bool {
    return c >= '0' && c <= '9';
  };

  auto number = [&](size_t pos, size_t count) -> int {
    int result = 0;
    for (size_t i = 0; i < count; ++i) {
      if (!digit(value[pos + i])) return -1;
      result = result * 10 + (value[pos + i] - '0');
    }
    return result;
  };

  const int year = number(0, 4);
  const int month = number(5, 2);
  const int day = number(8, 2);
  const int hour = number(11, 2);
  const int minute = number(14, 2);
  const int second = number(17, 2);

  if (year < 1 ||
      value[4] != '-' ||
      month < 1 || month > 12 ||
      value[7] != '-' ||
      value[10] != 'T' ||
      day < 1 ||
      value[13] != ':' ||
      hour < 0 || hour > 23 ||
      value[16] != ':' ||
      minute < 0 || minute > 59 ||
      second < 0 || second > 59) {
    return false;
  }

  const bool leapYear =
    (year % 4 == 0 && year % 100 != 0) ||
    (year % 400 == 0);

  const int daysInMonth[] = {
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31
  };

  if (day > daysInMonth[month - 1]) return false;

  size_t pos = 19;

  // Phần thập phân của giây.
  if (pos < len && value[pos] == '.') {
    ++pos;
    const size_t fractionStart = pos;

    while (pos < len && digit(value[pos])) {
      ++pos;
    }

    const size_t fractionLength = pos - fractionStart;

    if (fractionLength == 0 || fractionLength > 9) {
      return false;
    }
  }

  // UTC.
  if (pos < len && value[pos] == 'Z') {
    return pos + 1 == len;
  }

  // Offset dạng +HH:MM hoặc -HH:MM.
  if (pos + 6 != len ||
      (value[pos] != '+' && value[pos] != '-') ||
      !digit(value[pos + 1]) ||
      !digit(value[pos + 2]) ||
      value[pos + 3] != ':' ||
      !digit(value[pos + 4]) ||
      !digit(value[pos + 5])) {
    return false;
  }

  const int offsetHour = number(pos + 1, 2);
  const int offsetMinute = number(pos + 4, 2);

  if (offsetHour < 0 || offsetHour > 14 ||
      offsetMinute < 0 || offsetMinute > 59) {
    return false;
  }

  // ISO-8601 giới hạn offset tối đa ±14:00.
  if (offsetHour == 14 && offsetMinute != 0) {
    return false;
  }

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

  const bool isCanonical = doc.containsKey("msg_id");
  const bool isLegacy = doc.containsKey("eventId");

  if (isCanonical == isLegacy) {
    errorMessage = "Payload thieu hoac trung dinh dang";
    return false;
  }

  const char* id = nullptr;

  if (isCanonical) {
    if (doc.size() != 5 ||
        doc.containsKey("messageType") ||
        doc.containsKey("deviceId") ||
        doc.containsKey("roomCode")) {
      errorMessage = "Payload chuan chua truong khong hop le";
      return false;
    }

    const char* canonicalKeys[] = {
      "msg_id",
      "device_id",
      "room_id",
      "timestamp",
      "data"
    };

    for (JsonPair kv : doc.as<JsonObject>()) {
      bool allowed = false;

      for (const char* key : canonicalKeys) {
        if (strcmp(kv.key().c_str(), key) == 0) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        errorMessage = "Payload chuan chua truong la";
        return false;
      }
    }

    if (!doc["msg_id"].is<const char*>() ||
        !doc["device_id"].is<const char*>() ||
        !doc["room_id"].is<const char*>() ||
        !doc["timestamp"].is<uint64_t>() ||
        !doc["data"].is<JsonObject>()) {
      errorMessage = "Payload chuan sai kieu du lieu";
      return false;
    }

    id = doc["msg_id"].as<const char*>();

    const char* deviceId = doc["device_id"].as<const char*>();
    const char* roomId = doc["room_id"].as<const char*>();

    if (!id || !*id || strlen(id) > 64 ||
        !isValidIdentifierValue(deviceId) ||
        !isValidIdentifierValue(roomId)) {
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
        !data["lux"].is<float>() ||
        !data["occupancy"].is<bool>()) {
      errorMessage = "Du lieu telemetry chuan sai cau truc";
      return false;
    }

    const char* dataKeys[] = {
      "temperature",
      "humidity",
      "lux",
      "occupancy"
    };

    for (JsonPair kv : data) {
      bool allowed = false;

      for (const char* key : dataKeys) {
        if (strcmp(kv.key().c_str(), key) == 0) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        errorMessage = "Data telemetry chua truong la";
        return false;
      }
    }

    const double temperature = data["temperature"].as<double>();
    const double humidity = data["humidity"].as<double>();
    const double lux = data["lux"].as<double>();

    if (!isfinite(temperature) ||
        temperature < -10.0 || temperature > 60.0 ||
        !isfinite(humidity) ||
        humidity < 0.0 || humidity > 100.0 ||
        !isfinite(lux) ||
        lux < 0.0 || lux > 65535.0 ||
        floor(lux) != lux) {
      errorMessage = "Gia tri telemetry chuan vuot gioi han";
      return false;
    }

  } else {
    // Legacy có 7 trường bắt buộc và tối đa 2 trường tùy chọn:
    // timestamp, occupancy.
    if (doc.size() < 7 || doc.size() > 9 ||
        doc.containsKey("msg_id") ||
        doc.containsKey("device_id") ||
        doc.containsKey("room_id") ||
        doc.containsKey("data")) {
      errorMessage = "Payload legacy chua truong khong hop le";
      return false;
    }
    const char* allowedKeys[] = {
      "messageType",
      "eventId",
      "deviceId",
      "roomCode",
      "timestamp",
      "temperatureC",
      "humidityPercent",
      "illuminanceLux",
      "occupancy"
    };

    for (JsonPair kv : doc.as<JsonObject>()) {
      bool allowed = false;

      for (const char* key : allowedKeys) {
        if (strcmp(kv.key().c_str(), key) == 0) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        errorMessage = "Payload legacy chua truong la";
        return false;
      }
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

    if (strcmp(doc["messageType"].as<const char*>(),
               "telemetry") != 0) {
      errorMessage = "messageType legacy khong hop le";
      return false;
    }

    id = doc["eventId"].as<const char*>();

    if (!id || !*id || strlen(id) > 64 ||
        !isValidIdentifierValue(doc["deviceId"].as<const char*>()) ||
        !isValidIdentifierValue(doc["roomCode"].as<const char*>())) {
      errorMessage = "Payload legacy sai dinh danh";
      return false;
    }

    const double temperature = doc["temperatureC"].as<double>();
    const double humidity = doc["humidityPercent"].as<double>();
    const double lux = doc["illuminanceLux"].as<double>();

    if (!isfinite(temperature) ||
        temperature < -10.0 || temperature > 60.0 ||
        !isfinite(humidity) ||
        humidity < 0.0 || humidity > 100.0 ||
        !isfinite(lux) ||
        lux < 0.0 || lux > 65535.0) {
      errorMessage = "Gia tri telemetry legacy vuot gioi han";
      return false;
    }

    if (doc.containsKey("occupancy") &&
        !doc["occupancy"].is<bool>()) {
      errorMessage = "Occupancy legacy sai kieu du lieu";
      return false;
    }

    if (doc.containsKey("timestamp")) {
      if (!doc["timestamp"].is<const char*>() ||
          !isValidLegacyTimestamp(
            doc["timestamp"].as<const char*>())) {
        errorMessage = "Timestamp legacy khong hop le";
        return false;
      }
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
  if (!repairTrailingRecord()) {
    return false;
  }
  String incomingId;

  if (!validateRecord(jsonRecord, &incomingId)) {
    return false;
  }

  const size_t current = count();

  if (!errorMessage.isEmpty()) {
    return false;
  }

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

  const size_t oldSize = reader.size();
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

  // Kiểm tra kích thước file sau khi ghi.
  File verify = fs.open(queuePath, FILE_READ);

  if (!verify) {
    errorMessage = "Khong mo duoc queue sau khi ghi";
    return false;
  }

  const size_t newSize = verify.size();

  if (newSize != oldSize + written) {
    verify.close();
    errorMessage = "Kich thuoc queue sau khi ghi khong khop";
    return false;
  }

  // Đọc và xác thực bản ghi cuối.
  if (newSize < written ||
      !verify.seek(newSize - written)) {
    verify.close();
    errorMessage = "Khong doc duoc ban ghi vua ghi";
    return false;
  }

  String storedRecord = verify.readStringUntil('\n');
  storedRecord.trim();
  verify.close();

  String storedId;

  if (!validateRecord(storedRecord, &storedId)) {
    errorMessage = "Ban ghi vua ghi khong hop le";
    return false;
  }

  if (storedId != incomingId) {
    errorMessage = "ID ban ghi sau khi ghi khong khop";
    return false;
  }

  errorMessage = "";
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

  if (messageId.isEmpty()) {
    errorMessage = "msg_id can xoa rong";
    return false;
  }

  File source = fs.open(queuePath, FILE_READ);

  if (!source) {
    errorMessage = "Khong doc duoc queue goc";
    return false;
  }

  // Không ghi đè backup còn tồn tại.
  // Backup cũ phải được xử lý ở bước recovery.
  if (fs.exists(backupPath)) {
    source.close();
    errorMessage = "Backup da ton tai; tu choi thay the queue";
    return false;
  }

  if (fs.exists(tempPath) && !fs.remove(tempPath)) {
    source.close();
    errorMessage = "Khong xoa duoc file tam cu";
    return false;
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
      if (found) {
        // ID trùng trong queue là trạng thái không an toàn.
        ok = false;
        errorMessage = "Queue co ID trung lap";
        break;
      }

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
    if (fs.exists(tempPath) && !fs.remove(tempPath)) {
      errorMessage = "Tao file tam that bai va khong xoa duoc file tam";
      return false;
    }

    if (errorMessage.isEmpty()) {
      errorMessage = !found
        ? "Khong tim thay msg_id can xac nhan"
        : "Doc queue hoac ghi file tam that bai";
    }

    return false;
  }

  // Kiểm tra file tạm về kích thước và từng bản ghi.
  File check = fs.open(tempPath, FILE_READ);

  if (!check) {
    errorMessage = "Khong mo duoc file tam de kiem tra";
    return false;
  }

  bool tempValid = check.size() == expectedSize;

  while (tempValid && check.available()) {
    String line = check.readStringUntil('\n');
    line.trim();

    if (!line.isEmpty() && !validateRecord(line)) {
      tempValid = false;
    }
  }

  check.close();

  if (!tempValid) {
    errorMessage = "File tam khong hop le; giu nguyen queue goc";
    return false;
  }

  // Đưa queue gốc sang backup.
  if (!fs.rename(queuePath, backupPath)) {
    errorMessage = "Khong the chuyen queue goc sang backup";
    return false;
  }

  // Chuyển file tạm thành queue chính.
  if (!fs.rename(tempPath, queuePath)) {
    // Rollback: đưa backup trở lại queue chính.
    if (!fs.rename(backupPath, queuePath)) {
      errorMessage =
        "Thay the queue that bai; backup van duoc giu de phuc hoi";
    } else {
      errorMessage = "Thay the queue that bai; da rollback queue goc";
    }

    return false;
  }

  // Xác minh queue mới sau khi đổi tên.
  File finalQueue = fs.open(queuePath, FILE_READ);

  if (!finalQueue) {
    errorMessage = "Queue moi khong mo duoc sau khi thay the";
    return false;
  }

  bool finalValid = true;
  size_t finalSize = 0;

  while (finalQueue.available()) {
    String line = finalQueue.readStringUntil('\n');
    line.trim();

    if (line.isEmpty()) continue;

    finalSize += line.length() + 2;

    if (!validateRecord(line)) {
      finalValid = false;
      break;
    }
  }

  finalQueue.close();

  if (!finalValid || finalSize != expectedSize) {
    // Giữ nguyên queue mới lỗi và backup cũ để không mất dữ liệu.
    errorMessage =
      "Queue moi khong hop le; giu backup de phuc hoi";
    return false;
  }

  // Chỉ xóa backup sau khi queue mới đã được xác minh.
  if (!fs.remove(backupPath)) {
    errorMessage =
      "Queue moi hop le nhung khong xoa duoc backup cu";
    return false;
  }

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