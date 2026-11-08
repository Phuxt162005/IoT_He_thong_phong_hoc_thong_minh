#include "OledDisplay.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

OledDisplay::OledDisplay(uint8_t i2cAddress)
  : _i2cAddress(i2cAddress),
    _display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET) {}

bool OledDisplay::begin() {
  // Khoi tao SSD1306 voi nguon noi switch-cap
  if (!_display.begin(SSD1306_SWITCHCAPVCC, _i2cAddress)) {
    Serial.printf("[OLED] Canh bao: Khong tim thay SSD1306 tai 0x%02X. He thong van hoat dong binh thuong.\n", _i2cAddress);
    _available = false;
    return false;
  }

  _available = true;
  _display.clearDisplay();
  _display.setTextColor(SSD1306_WHITE);

  // Man hinh chao
  _display.setTextSize(1);
  _display.setCursor(10, 15);
  _display.println("SMART CLASSROOM");
  _display.setCursor(18, 32);
  _display.println("SENSOR NODE");
  _display.setCursor(22, 48);
  _display.println("Khoi dong...");
  _display.display();

  Serial.println("[OLED] Khoi tao man hinh SSD1306 128x64 thanh cong!");
  return true;
}

void OledDisplay::update(
  const TelemetrySample& sample,
  bool wifiConnected,
  bool mqttConnected,
  size_t queuedCount,
  uint32_t sampleInterval,
  uint32_t heartbeatInterval
) {
  if (!_available) return;

  _display.clearDisplay();

  // 1. Header (y: 0 - 10)
  _display.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  _display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  _display.setTextSize(1);
  _display.setCursor(4, 2);
  _display.print("SMART ROOM A101");

  _display.setCursor(100, 2);
  _display.print(mqttConnected ? "MQTT" : (wifiConnected ? "WIFI" : "OFF"));

  // 2. Thong so moi truong (y: 15 - 35)
  _display.setTextColor(SSD1306_WHITE);

  // Dong 1: Nhiet do & Do am
  _display.setCursor(0, 15);
  _display.printf("T: %.1f C", sample.temperatureC);
  _display.setCursor(68, 15);
  _display.printf("H: %.0f %%", sample.humidityPercent);

  // Dong 2: Cuong do sang & Hien dien (Occupancy)
  _display.setCursor(0, 27);
  _display.printf("L: %u lx", sample.illuminanceLux);
  _display.setCursor(68, 27);
  _display.printf("Occ: %s", sample.occupancy ? "YES" : "NO");

  // 3. Duong phan cach
  _display.drawLine(0, 39, 128, 39, SSD1306_WHITE);

  // 4. Trang thai he thong & Hang doi ngoai tuyen (y: 43 - 60)
  _display.setCursor(0, 43);
  _display.printf("Net: W:%s M:%s", wifiConnected ? "OK" : "NO", mqttConnected ? "OK" : "NO");

  _display.setCursor(0, 54);
  _display.printf("Queue:%u  Cfg:%us/%us", (unsigned int)queuedCount, sampleInterval, heartbeatInterval);

  _display.display();
}

