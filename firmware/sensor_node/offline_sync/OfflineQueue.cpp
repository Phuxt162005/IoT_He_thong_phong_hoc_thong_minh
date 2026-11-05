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
  // Nếu queue đã tồn tại thì đây là bản chính.
  if (fs.exists(queuePath)) {
    if (fs.exists(tempPath)) fs.remove(tempPath);
    if (fs.exists(backupPath)) fs.remove(backupPath);
    return true;
  }

  // Crash sau khi đổi tên queue -> backup.
  if (fs.exists(backupPath)) {
    if (!fs.rename(backupPath, queuePath)) {
      errorMessage = "Khong khoi phuc duoc backup";
      return false;
    }
    if (fs.exists(tempPath)) fs.remove(tempPath);
    return true;
  }

  // Chỉ dùng temp khi chưa có queue và backup.
  if (fs.exists(tempPath)) {
    if (!fs.rename(tempPath, queuePath)) {
      errorMessage = "Khong khoi phuc duoc file tam";
      return false;
    }
    return true;
  }

  File file = fs.open(queuePath, FILE_WRITE);
  if (!file) {
    errorMessage = "Khong tao duoc file hang doi";
    return false;
  }
  file.close();
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

bool OfflineQueue::validateRecord(const String& json, String* messageId) {
  StaticJsonDocument<2048> doc;
  DeserializationError err = deserializeJson(doc, json);

  if (err || !doc.is<JsonObject>()) {
    errorMessage = "Ban ghi JSON khong hop le";
    return false;
  }

  // Hỗ trợ cả payload MQTT chuẩn và payload legacy.
  const char* id = doc["msg_id"];
  if (!id) id = doc["eventId"];
  if (!id || !*id || strlen(id) > 64) {
    errorMessage = "Ban ghi thieu msg_id/eventId hop le";
    return false;
  }

  if (doc.containsKey("msg_id")) {
    const char* deviceId = doc["device_id"];
    const char* roomId = doc["room_id"];
    if (!deviceId || !*deviceId || !roomId || !*roomId) {
      errorMessage = "Payload chuan thieu device_id/room_id";
      return false;
    }
  } else {
    const char* deviceId = doc["deviceId"];
    const char* roomId = doc["roomCode"];
    if (!deviceId || !*deviceId || !roomId || !*roomId) {
      errorMessage = "Payload legacy thieu deviceId/roomCode";
      return false;
    }
  }

  if (messageId) *messageId = String(id);
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
  File source = fs.open(queuePath, FILE_READ);
  if (!source) {
    errorMessage = "Khong doc duoc hang doi goc";
    return false;
  }

  if (fs.exists(tempPath)) fs.remove(tempPath);
  File target = fs.open(tempPath, FILE_WRITE);
  if (!target) {
    source.close();
    errorMessage = "Khong tao duoc file tam";
    return false;
  }

  bool found = false;
  bool ok = true;

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

    if (target.println(line) == 0) {
      ok = false;
      break;
    }
  }

  target.flush();
  target.close();
  source.close();

  if (!ok || !found) {
    fs.remove(tempPath);
    errorMessage = !ok ? "Hang doi loi hoac ghi file tam that bai"
                       : "Khong tim thay msg_id can xac nhan";
    return false;
  }

  if (fs.exists(backupPath)) fs.remove(backupPath);

  if (!fs.rename(queuePath, backupPath)) {
    fs.remove(tempPath);
    errorMessage = "Khong tao duoc backup";
    return false;
  }

  if (!fs.rename(tempPath, queuePath)) {
    fs.rename(backupPath, queuePath);
    errorMessage = "Khong thay the duoc hang doi";
    return false;
  }

  fs.remove(backupPath);
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