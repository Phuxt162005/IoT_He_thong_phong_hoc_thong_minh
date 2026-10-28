#include "OfflineQueue.h"
#include <ArduinoJson.h>

OfflineQueue::OfflineQueue(fs::FS& filesystem, size_t maxRecords)
  : fs(filesystem), capacity(maxRecords) {}

bool OfflineQueue::begin() {
  errorMessage = "";
  return recoverFiles();
}

String OfflineQueue::lastError() const {
  return errorMessage;
}

bool OfflineQueue::recoverFiles() {
  if (fs.exists(queuePath)) {
    if (fs.exists(tempPath)) fs.remove(tempPath);
    if (fs.exists(backupPath)) fs.remove(backupPath);
    return true;
  }

  if (fs.exists(backupPath)) {
    if (fs.rename(backupPath, queuePath)) {
      if (fs.exists(tempPath)) fs.remove(tempPath);
      return true;
    }
    errorMessage = "Khong khoi phuc duoc file backup";
    return false;
  }

  if (fs.exists(tempPath)) {
    if (fs.rename(tempPath, queuePath)) return true;
    errorMessage = "Khong khoi phuc duoc file tam";
    return false;
  }

  File file = fs.open(queuePath, FILE_WRITE);
  if (!file) {
    errorMessage = "Khong tao duoc file hang doi";
    return false;
  }
  file.close();
  return true;
}

bool OfflineQueue::validateRecord(const String& jsonRecord, String* eventId) {
  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, jsonRecord);

  if (err || !doc.is<JsonObject>()) {
    errorMessage = "Ban ghi JSON khong hop le";
    return false;
  }

  const char* id = doc["eventId"];
  if (!id || String(id).length() == 0) {
    errorMessage = "Ban ghi thieu eventId";
    return false;
  }

  if (eventId) *eventId = String(id);
  return true;
}

size_t OfflineQueue::count() {
  File file = fs.open(queuePath, FILE_READ);
  if (!file) {
    errorMessage = "Khong doc duoc file hang doi";
    return 0;
  }

  size_t total = 0;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (!line.isEmpty()) total++;
  }
  file.close();
  return total;
}

bool OfflineQueue::isFull() {
  return count() >= capacity;
}

bool OfflineQueue::enqueue(const String& jsonRecord) {
  errorMessage = "";

  if (!validateRecord(jsonRecord)) return false;
  if (isFull()) {
    errorMessage = "Hang doi day; khong ghi de du lieu cu";
    return false;
  }

  // Chống thêm lại eventId đã có trong hàng đợi.
  String incomingId;
  if (!validateRecord(jsonRecord, &incomingId)) return false;

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
      errorMessage = "eventId da ton tai trong hang doi";
      return false;
    }
  }
  reader.close();

  File writer = fs.open(queuePath, FILE_APPEND);
  if (!writer) {
    errorMessage = "Khong mo duoc hang doi de ghi";
    return false;
  }

  const size_t written = writer.println(jsonRecord);
  writer.flush();
  writer.close();

  if (written == 0) {
    errorMessage = "Ghi ban ghi that bai";
    return false;
  }
  return true;
}

bool OfflineQueue::peek(String& jsonRecord) {
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
  return false; // Hàng đợi rỗng.
}

bool OfflineQueue::rewriteWithoutEvent(const String& eventId) {
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

    if (currentId == eventId) {
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
    if (!ok) errorMessage = "Du lieu hang doi khong hop le hoac ghi file tam that bai";
    else errorMessage = "Khong tim thay eventId can xac nhan";
    return false;
  }

  if (fs.exists(backupPath)) fs.remove(backupPath);

  if (!fs.rename(queuePath, backupPath)) {
    fs.remove(tempPath);
    errorMessage = "Khong tao duoc backup hang doi";
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

bool OfflineQueue::acknowledge(const String& eventId) {
  errorMessage = "";
  if (eventId.isEmpty()) {
    errorMessage = "eventId ACK rong";
    return false;
  }
  return rewriteWithoutEvent(eventId);
}