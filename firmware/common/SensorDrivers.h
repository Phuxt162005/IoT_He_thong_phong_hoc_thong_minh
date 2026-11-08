#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include <BH1750.h>
#include "TelemetryMessage.h"

class SensorDrivers {
public:
  SensorDrivers(
    uint8_t pinDht = 4,
    uint8_t pinSda = 21,
    uint8_t pinScl = 22,
    uint8_t pinPir = 27,
    uint32_t occupancyHoldMs = 20000
  );

  // Khởi tạo phần cứng cảm biến (Wire, BH1750, DHT22, PIR)
  bool begin();

  // Đọc mẫu dữ liệu cảm biến thực tế (có cơ chế dự phòng an toàn nếu cảm biến chưa cắm)
  bool readSample(TelemetrySample& sample);

  // Trạng thái phần cứng
  bool isBh1750Available() const { return _bh1750Available; }
  bool isDhtAvailable() const { return _dhtAvailable; }
  bool isPirDetected() const { return _pirDetected; }

  // Cấu hình chế độ giả lập nếu không có phần cứng
  void setSimulationMode(bool enabled) { _simulateMissing = enabled; }

private:
  uint8_t _pinDht;
  uint8_t _pinSda;
  uint8_t _pinScl;
  uint8_t _pinPir;
  uint32_t _occupancyHoldMs;

  DHT _dht;
  BH1750 _lightMeter;

  bool _bh1750Available = false;
  bool _dhtAvailable = false;
  bool _pirDetected = false;
  bool _simulateMissing = true; // Tự động dự phòng thông số an toàn nếu cảm biến lỏng dây

  uint32_t _lastMotionMs = 0;
  float _lastValidTemp = 26.5f;
  float _lastValidHum = 65.0f;
  uint16_t _lastValidLux = 350;
};

