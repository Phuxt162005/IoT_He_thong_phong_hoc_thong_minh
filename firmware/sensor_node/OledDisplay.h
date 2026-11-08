#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "TelemetryMessage.h"

class OledDisplay {
public:
  OledDisplay(uint8_t i2cAddress = 0x3C);

  // Khoi tao man hinh OLED
  bool begin();

  // Cap nhat giao dien hien thi thong so phong hoc
  void update(
    const TelemetrySample& sample,
    bool wifiConnected,
    bool mqttConnected,
    size_t queuedCount,
    uint32_t sampleInterval,
    uint32_t heartbeatInterval
  );

  bool isAvailable() const { return _available; }

private:
  uint8_t _i2cAddress;
  Adafruit_SSD1306 _display;
  bool _available = false;
  uint32_t _lastRenderMs = 0;
};

