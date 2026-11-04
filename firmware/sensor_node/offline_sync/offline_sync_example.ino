
#include <WiFi.h>
#include <LittleFS.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "OfflineQueue.h"

const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST = "192.168.1.100";
const uint16_t MQTT_PORT = 1883;

// Các thông tin này phải khớp credential được backend cấp cho thiết bị.
const char* DEVICE_ID = "SENSOR_01";
const char* MQTT_USERNAME = "SENSOR_01";
const char* MQTT_PASSWORD = "DEVICE_PASSWORD_FROM_PROVISIONING";
const char* ROOM_CODE = "ROOM_302";

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
OfflineQueue offlineQueue(LittleFS, 100);

String telemetryTopic;
String ackTopic;
String bootId;

uint32_t eventCounter = 0;
uint32_t lastSampleAt = 0;
uint32_t lastReconnectAt = 0;
uint32_t lastPublishAt = 0;

const uint32_t SAMPLE_INTERVAL_MS = 5000;
const uint32_t RECONNECT_INTERVAL_MS = 5000;
const uint32_t PUBLISH_INTERVAL_MS = 2000;

String makeEventId() {
  char randomPart[9];
  snprintf(randomPart, sizeof(randomPart), "%08lX", (unsigned long)esp_random());
  eventCounter++;
  return String(DEVICE_ID) + "-" + bootId + "-" + randomPart + "-" + String(eventCounter);
}

String getTimestamp() {
  struct tm timeInfo;
  if (getLocalTime(&timeInfo, 20)) {
    char buffer[25];
    strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeInfo);
    return String(buffer);
  }
  return "";
}

bool readSensorValues(float& temperature, float& humidity, float& illuminance) {
  // TODO: Thay bằng thao tác đọc cảm biến thực tế.
  // Không sử dụng các giá trị giả này để đánh giá kết quả đo.
  temperature = 27.0;
  humidity = 65.0;
  illuminance = 320.0;
  return true;
}

bool enqueueTelemetry() {
  float temperature, humidity, illuminance;
  if (!readSensorValues(temperature, humidity, illuminance)) return false;

  StaticJsonDocument<512> doc;
  doc["messageType"] = "telemetry";
  doc["eventId"] = makeEventId();
  doc["deviceId"] = DEVICE_ID;
  doc["roomCode"] = ROOM_CODE;
  doc["timestamp"] = getTimestamp();
  doc["temperatureC"] = temperature;
  doc["humidityPercent"] = humidity;
  doc["illuminanceLux"] = illuminance;

  String json;
  serializeJson(doc, json);

  if (!offlineQueue.enqueue(json)) {
    Serial.print("Khong luu duoc telemetry: ");
    Serial.println(offlineQueue.lastError());
    return false;
  }

  return true;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != ackTopic) return;

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, length);

  if (err || !doc.is<JsonObject>()) {
    Serial.println("ACK JSON khong hop le");
    return;
  }

  const char* messageType = doc["messageType"];
  const char* eventId = doc["eventId"];
  const char* status = doc["status"];

  if (!messageType || !eventId || !status) return;
  if (String(messageType) != "telemetry_ack") return;
  if (String(status) != "STORED") return;

  if (offlineQueue.acknowledge(String(eventId))) {
    Serial.print("Backend da xac nhan eventId: ");
    Serial.println(eventId);
  } else {
    Serial.print("Khong xoa duoc ban ghi: ");
    Serial.println(offlineQueue.lastError());
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) return;

  // Dynamic Security yêu cầu Client ID khớp với client_id đã provision.
  // Backend cấp username và client_id đều bằng DEVICE_ID.
  if (mqttClient.connect(DEVICE_ID, MQTT_USERNAME, MQTT_PASSWORD)) {
    mqttClient.subscribe(ackTopic.c_str(), 1);
    Serial.println("MQTT authenticated and connected");
  } else {
    Serial.print("MQTT connection failed, state: ");
    Serial.println(mqttClient.state());
  }
}

void publishNextQueuedRecord() {
  if (!mqttClient.connected()) return;
  if (millis() - lastPublishAt < PUBLISH_INTERVAL_MS) return;

  lastPublishAt = millis();

  String record;
  if (!offlineQueue.peek(record)) return;

  // Publish thành công chỉ có nghĩa MQTT đã nhận bản tin.
  // Không xóa bản ghi cho đến khi nhận ACK STORED từ backend.
  if (!mqttClient.publish(telemetryTopic.c_str(), record.c_str(), false)) {
    Serial.println("Publish that bai; giu ban ghi trong hang doi");
  }
}

void setup() {
  Serial.begin(115200);

  uint32_t bootRandom = esp_random();
  char bootBuffer[9];
  snprintf(bootBuffer, sizeof(bootBuffer), "%08lX", (unsigned long)bootRandom);
  bootId = String(bootBuffer);

  telemetryTopic = "smartclassroom/room/" + String(ROOM_CODE) +
                   "/device/" + String(DEVICE_ID) + "/telemetry";

  ackTopic = telemetryTopic + "/ack";

  if (!LittleFS.begin(false)) {
    Serial.println("LittleFS mount that bai; dung de tranh format mat du lieu");
    while (true) delay(1000);
  }

  if (!offlineQueue.begin()) {
    Serial.print("Khoi tao hang doi that bai: ");
    Serial.println(offlineQueue.lastError());
    while (true) delay(1000);
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
  mqttClient.setKeepAlive(30);

  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  connectWiFi();

  Serial.printf("Offline queue co %u ban ghi\n", (unsigned)offlineQueue.count());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED &&
      millis() - lastReconnectAt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAt = millis();
    connectWiFi();
  }

  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected() &&
      millis() - lastReconnectAt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAt = millis();
    connectMqtt();
  }

  mqttClient.loop();

  if (millis() - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = millis();
    enqueueTelemetry();
  }

  publishNextQueuedRecord();
}
