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
// 3. Thông tin Thiết bị Control Node (Lấy trên Web sau khi nhấn Provision)
// ==============================================================================
#define DEVICE_ID               "CN-A101-01"      // Mã thiết bị Control Node
#define ROOM_ID                 "A101"            // Mã phòng học
#define MQTT_USERNAME           "CN-A101-01"      // Trùng với DEVICE_ID
#define MQTT_PASSWORD           "YOUR_DEVICE_SECRET" // Secret được cấp khi Provision

// ==============================================================================
// 4. Thông số vận hành
// ==============================================================================
#define FIRMWARE_VERSION        "1.0.0"
#define HEARTBEAT_INTERVAL_S    10                // Chu kỳ gửi Heartbeat (giây)

// ==============================================================================
// 5. Sơ đồ chân phần cứng Control Node (ESP32 số 2)
// ==============================================================================
#define PIN_RELAY_FAN           25                // GPIO 25: Relay K1 - Quạt (FAN)
#define PIN_RELAY_LIGHT         26                // GPIO 26: Relay K2 - Đèn (LIGHT)
#define RELAY_ACTIVE_LOW        true              // true nếu relay kích mức LOW (phổ biến)

