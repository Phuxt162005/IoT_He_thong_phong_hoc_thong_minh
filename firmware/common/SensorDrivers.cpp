#include "SensorDrivers.h"

SensorDrivers::SensorDrivers(
  uint8_t pinDht,
  uint8_t pinSda,
  uint8_t pinScl,
  uint8_t pinPir,
  uint32_t occupancyHoldMs
) : _pinDht(pinDht),
    _pinSda(pinSda),
    _pinScl(pinScl),
    _pinPir(pinPir),
    _occupancyHoldMs(occupancyHoldMs),
    _dht(pinDht, DHT22) {}

bool SensorDrivers::begin() {
  Serial.println("[Sensor] Khoi tao cac cam bien...");

  // 1. Khoi tao I2C Bus Wire cho BH1750 (va OLED)
  Wire.begin(_pinSda, _pinScl);

  // 2. Khoi tao BH1750 qua I2C (thu dia chi mac dinh 0x23, sau do 0x5C)
  if (_lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire)) {
    _bh1750Available = true;
    Serial.println("[Sensor] BH1750 (Anh sang) ket noi thanh cong tai 0x23.");
  } else if (_lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &Wire)) {
    _bh1750Available = true;
    Serial.println("[Sensor] BH1750 (Anh sang) ket noi thanh cong tai 0x5C.");
  } else {
    _bh1750Available = false;
    Serial.println("[Sensor] Canh bao: Khong tim thay BH1750 tren I2C. Kich hoat che do du phong.");
  }

  // 3. Khoi tao DHT22 (Nhiet do & Do am)
  _dht.begin();
  pinMode(_pinDht, INPUT_PULLUP);

  // 4. Khoi tao PIR (Chuyen dong)
  pinMode(_pinPir, INPUT);

  // Doc thu DHT22 lan dau de khoi dong cam bien
  float testT = _dht.readTemperature();
  float testH = _dht.readHumidity();
  if (!isnan(testT) && !isnan(testH)) {
    _dhtAvailable = true;
    _lastValidTemp = testT;
    _lastValidHum = testH;
    Serial.printf("[Sensor] DHT22 san sang: Nhiet do=%.1f C, Do am=%.1f %%\n", testT, testH);
  } else {
    _dhtAvailable = false;
    Serial.println("[Sensor] Canh bao: DHT22 chua san sang hoac chua cam. Kich hoat che do du phong an toan.");
  }

  return true;
}

bool SensorDrivers::readSample(TelemetrySample& sample) {
  // 1. Doc DHT22 (Nhiet do va Do am)
  float t = _dht.readTemperature();
  float h = _dht.readHumidity();

  bool dhtOk = !isnan(t) && !isnan(h) && t >= -10.0f && t <= 60.0f && h >= 0.0f && h <= 100.0f;
  if (dhtOk) {
    _dhtAvailable = true;
    _lastValidTemp = t;
    _lastValidHum = h;
    sample.temperatureC = t;
    sample.humidityPercent = h;
  } else {
    _dhtAvailable = false;
    if (_simulateMissing) {
      // Tao dao dong nhe quanh moc tieu chuan de he thong van co du lieu chay kiem thu
      float deltaT = ((int)(esp_random() % 11) - 5) / 10.0f; // [-0.5, 0.5]
      float deltaH = ((int)(esp_random() % 21) - 10) / 10.0f; // [-1.0, 1.0]
      sample.temperatureC = _lastValidTemp + deltaT;
      sample.humidityPercent = _lastValidHum + deltaH;
    } else {
      sample.temperatureC = _lastValidTemp;
      sample.humidityPercent = _lastValidHum;
    }
  }

  // 2. Doc BH1750 (Cuong do anh sang)
  if (_bh1750Available) {
    float lux = _lightMeter.readLightLevel();
    if (lux >= 0.0f && !isnan(lux) && lux <= 65535.0f) {
      _lastValidLux = (uint16_t)lux;
      sample.illuminanceLux = _lastValidLux;
    } else {
      sample.illuminanceLux = _lastValidLux;
    }
  } else {
    if (_simulateMissing) {
      int deltaLux = (int)(esp_random() % 31) - 15;
      int simulated = (int)_lastValidLux + deltaLux;
      if (simulated < 50) simulated = 50;
      if (simulated > 2000) simulated = 2000;
      sample.illuminanceLux = (uint16_t)simulated;
    } else {
      sample.illuminanceLux = _lastValidLux;
    }
  }

  // 3. Doc PIR (Phat hien nguoi)
  int pirState = digitalRead(_pinPir);
  if (pirState == HIGH) {
    _lastMotionMs = millis();
    _pirDetected = true;
  }
  sample.occupancy = (millis() - _lastMotionMs < _occupancyHoldMs);

  return true;
}

