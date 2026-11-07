#pragma once

// ==============================================================================
// 1. Cấu hình Mạng Wi-Fi
// ==============================================================================
#define WIFI_SSID               "YOUR_WIFI_SSID"
#define WIFI_PASSWORD           "YOUR_WIFI_PASSWORD"

// ==============================================================================
// 2. Cấu hình MQTT Broker
// ==============================================================================
#define MQTT_HOST               "192.168.1.100"   // IP của máy tính chạy Docker / Mosquitto
#define MQTT_PORT               1884              // Cổng Mosquitto trên máy chủ

// ==============================================================================
// 3. Thông tin Thiết bị Sensor Node (Lấy trên Web sau khi nhấn Provision)
// ==============================================================================
#define DEVICE_ID               "SN-A101-01"      // Mã thiết bị Sensor Node
#define ROOM_ID                 "A101"            // Mã phòng học
#define MQTT_USERNAME           "SN-A101-01"      // Trùng với DEVICE_ID
#define MQTT_PASSWORD           "YOUR_DEVICE_SECRET" // Secret được cấp khi Provision

// ==============================================================================
// 4. Thông số vận hành
// ==============================================================================
#define FIRMWARE_VERSION        "1.0.0"
#define HEARTBEAT_INTERVAL_S    10                // Chu kỳ gửi Heartbeat (giây)
#define SAMPLE_INTERVAL_S       5                 // Chu kỳ đọc cảm biến (giây)

// ==============================================================================
// 5. Sơ đồ chân phần cứng Sensor Node (ESP32 số 1)
// ==============================================================================
#define PIN_DHT22               4                 // GPIO 4: Cảm biến nhiệt độ & độ ẩm DHT22
#define PIN_I2C_SDA             21                // GPIO 21: SDA (BH1750 + OLED SSD1306)
#define PIN_I2C_SCL             22                // GPIO 22: SCL (BH1750 + OLED SSD1306)
#define PIN_PIR                 27                // GPIO 27: Cảm biến phát hiện người PIR

