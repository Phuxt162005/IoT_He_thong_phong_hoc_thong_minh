#pragma once

#include <Arduino.h>
#include <FS.h>

class OfflineQueue {
public:
  explicit OfflineQueue(fs::FS& filesystem, size_t maxRecords = 100);

  bool begin();
  bool enqueue(const String& jsonRecord);
  bool peek(String& jsonRecord);
  bool acknowledge(const String& eventId);
  size_t count();
  bool isFull();
  String lastError() const;

private:
  fs::FS& fs;
  size_t capacity;
  String errorMessage;

  const char* queuePath = "/telemetry_queue.jsonl";
  const char* tempPath = "/telemetry_queue.tmp";
  const char* backupPath = "/telemetry_queue.bak";

  bool recoverFiles();
  bool validateRecord(const String& jsonRecord, String* eventId = nullptr);
  bool rewriteWithoutEvent(const String& eventId);
};