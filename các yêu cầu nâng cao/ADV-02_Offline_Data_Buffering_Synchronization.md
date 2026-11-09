# ADV-02 — Lưu dữ liệu khi mất mạng và đồng bộ lại

> **Tên tiếng Anh:** Offline Data Buffering & Synchronization  
> **Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
> **Phạm vi:** Firmware ESP32 (Sensor Node), MQTT và Backend PostgreSQL  
> **Trạng thái tổng hợp:** Firmware Sensor Node đã tích hợp SensorDrivers, hàng đợi LittleFS và MqttSyncManager. Firmware Sensor Node và Control Node đã biên dịch thành công trên GitHub Actions. Backend đã triển khai luồng tiếp nhận telemetry, lưu dữ liệu PostgreSQL và xác nhận ACK sau khi transaction hoàn tất. GitHub Actions Backend Checks trên commit `abab893` đạt kết quả 106/106 test PASS, bao gồm unit test Node.js 22, Node.js 24, integration test và deployment. Chưa kiểm thử mất mạng, khôi phục kết nối và phục hồi hàng đợi LittleFS trên ESP32 thật.

---

## 1. Mục tiêu và phạm vi

ADV-02 nhằm hạn chế mất dữ liệu telemetry khi Sensor Node không thể gửi dữ liệu do Wi-Fi hoặc MQTT bị gián đoạn. Thiết bị lưu tạm các bản ghi vào bộ nhớ flash bằng LittleFS. Khi kết nối được khôi phục, thiết bị gửi lại những bản ghi chưa được backend xác nhận.

Backend tiếp nhận và kiểm tra dữ liệu, lưu vào PostgreSQL. Backend chỉ gửi ACK ứng dụng sau khi transaction lưu dữ liệu hoàn tất thành công. Mỗi bản tin có mã định danh (`eventId` hoặc `msg_id`, tùy định dạng payload) để nhận diện bản tin gửi lại và tránh tạo dữ liệu trùng.

### 1.1. Các chức năng thuộc ADV-02

- Lưu telemetry vào hàng đợi LittleFS trước khi gửi MQTT.
- Gán mã định danh riêng cho từng bản ghi.
- Đọc và gửi lại bản ghi chưa được xác nhận khi MQTT kết nối.
- Chỉ xóa bản ghi khỏi hàng đợi khi nhận ACK ứng dụng hợp lệ, có mã định danh tương ứng và trạng thái `STORED`.
- Giới hạn số bản ghi; không ghi đè dữ liệu cũ khi hàng đợi đầy.
- Phục hồi hàng đợi từ file chính, file tạm hoặc file backup khi thiết bị khởi động lại.
- Backend kiểm tra payload, đối chiếu định danh thiết bị/phòng với MQTT topic, lưu telemetry vào PostgreSQL và chống trùng theo thiết bị cùng mã bản tin.
- Phân biệt dữ liệu bù offline với dữ liệu mới nhất. Bản ghi lịch sử vẫn được lưu nhưng không được ghi đè trạng thái mới nhất nếu không đủ điều kiện.
- Không gửi ACK `STORED` nếu transaction lưu dữ liệu thất bại.

## 2. Nguyên lý hoạt động

1. Sensor Node thu thập dữ liệu cảm biến và tạo mã định danh duy nhất cho bản ghi.
2. Thiết bị ghi bản ghi telemetry vào hàng đợi LittleFS trước khi gửi MQTT.
3. Nếu Wi-Fi hoặc MQTT không khả dụng, bản ghi tiếp tục được giữ trong hàng đợi.
4. Khi kết nối được khôi phục, thiết bị đọc bản ghi chưa được xác nhận ở đầu hàng đợi và publish lên topic telemetry.
5. Backend nhận bản tin MQTT, chuẩn hóa payload và kiểm tra tính hợp lệ cũng như sự khớp nhau giữa định danh trong payload và topic.
6. Backend xử lý trong transaction PostgreSQL: kiểm tra trạng thái thiết bị, kiểm tra trùng mã bản tin, lưu dữ liệu cảm biến và cập nhật dữ liệu mới nhất nếu bản ghi đủ điều kiện.
7. Chỉ sau khi transaction hoàn tất thành công, backend mới gửi ACK ứng dụng với trạng thái `STORED`.
8. ESP32 kiểm tra ACK. Chỉ khi mã định danh khớp và trạng thái là `STORED`, thiết bị mới xóa bản ghi tương ứng khỏi hàng đợi.
9. Nếu ACK bị mất, thiết bị gửi lại cùng bản ghi. Backend nhận diện bản tin đã lưu và không tạo thêm bản ghi trùng.

### 2.1. Cơ chế gửi và xác nhận

Thiết kế sử dụng **at-least-once delivery** ở tầng ứng dụng. Một bản ghi có thể được gửi nhiều lần nếu thiết bị không nhận được ACK. Backend bảo đảm tính idempotent bằng khóa định danh bản tin theo thiết bị.

MQTT QoS 1 không thay thế ACK ứng dụng. QoS 1 xác nhận việc chuyển giao bản tin ở tầng MQTT, không chứng minh dữ liệu đã được commit thành công vào PostgreSQL. Vì vậy, thiết bị không được xóa bản ghi chỉ dựa trên kết quả publish MQTT.

### 2.2. Phân biệt dữ liệu lịch sử và dữ liệu mới nhất

Khi thiết bị kết nối lại, các bản ghi tích lũy trong thời gian mất mạng có thể được gửi sau một bản ghi mới hơn. Backend cần giữ đúng thời điểm đo của từng bản ghi để phục vụ truy vấn lịch sử.

Bản ghi bù offline (`is_backfill`) vẫn được lưu vào bảng lịch sử, nhưng không được ghi đè dữ liệu mới nhất hoặc trở thành dữ liệu đủ điều kiện cho các xử lý phụ thuộc vào trạng thái hiện tại. Tài liệu đầu vào ghi nhận trường hợp này đã được xác nhận trong integration test.

## 3. Cấu trúc mã nguồn liên quan

## 3. Cấu trúc mã nguồn liên quan

````text
source code IoT/
├── backend/
│   └── src/
│       └── modules/
│           └── telemetry-ingestion/
│               ├── telemetry-pipeline.js
│               ├── telemetry-ingestion.service.js
│               ├── telemetry-ingestion.repository.pg.js
│               └── telemetry-normalizer.js
├── firmware/
│   ├── common/
│   │   ├── ActuatorManager.cpp
│   │   ├── ActuatorManager.h
│   │   ├── Config.h.example
│   │   ├── NodeSessionManager.cpp
│   │   ├── NodeSessionManager.h
│   │   ├── OledDisplay.cpp
│   │   ├── OledDisplay.h
│   │   ├── RemoteConfigManager.cpp
│   │   ├── RemoteConfigManager.h
│   │   ├── SensorDrivers.cpp
│   │   ├── SensorDrivers.h
│   │   ├── TelemetryMessage.cpp
│   │   └── TelemetryMessage.h
│   ├── control_node/
│   │   ├── control_node.ino
│   │   ├── ActuatorManager.cpp
│   │   ├── ActuatorManager.h
│   │   ├── NodeSessionManager.cpp
│   │   ├── NodeSessionManager.h
│   │   ├── RemoteConfigManager.cpp
│   │   └── RemoteConfigManager.h
│   └── sensor_node/
│       ├── sensor_node.ino
│       ├── Config.h.example
│       ├── OfflineQueue.cpp
│       ├── OfflineQueue.h
│       ├── MqttSyncManager.cpp
│       ├── MqttSyncManager.h
│       ├── TelemetryMessage.cpp
│       ├── TelemetryMessage.h
│       ├── SensorDrivers.cpp
│       ├── SensorDrivers.h
│       ├── NodeSessionManager.cpp
│       ├── NodeSessionManager.h
│       ├── OledDisplay.cpp
│       ├── OledDisplay.h
│       ├── RemoteConfigManager.cpp
│       └── RemoteConfigManager.h
├── deployment/
│   └── compose.yml
├── tests/
│   ├── helpers/
│   │   ├── database.js
│   │   └── iot.js
│   └── integration/
│       ├── telemetry.test.js
│       └── phase3-firmware-sensor.test.js
└── .github/
    └── workflows/
        ├── backend.yml
        └── firmware.yml


**Lưu ý:** Trong cây trên, các file `TelemetryMessage` và `SensorDrivers` ở `common` vẫn được giữ. Không nhầm việc xóa bản trùng OfflineQueue/MqttSyncManager với xóa toàn bộ module dùng chung.

## Bước 3 — Sửa mục 3.1: Trách nhiệm các thành phần

Tìm bảng bắt đầu bằng:

`### 3.1. Trách nhiệm các thành phần`

Xóa hai dòng bảng cũ mô tả:

- `firmware/sensor_node/offline_sync/`
- `firmware/sensor_node/offline_sync/offline_sync_example.ino`

Thay bằng dòng sau:

```markdown
| `firmware/common/` | Chứa các module dùng chung giữa các loại node như NodeSessionManager, OledDisplay, RemoteConfigManager, SensorDrivers và TelemetryMessage. Không chứa bộ triển khai OfflineQueue/MqttSyncManager đang được Sensor Node sử dụng. |
| `.github/workflows/firmware.yml` | Cài đặt Arduino CLI, ESP32 Arduino Core và các thư viện; tạo Config.h từ file mẫu rồi biên dịch Sensor Node và Control Node trên GitHub Actions. |, chưa thực hiện trong lần cập nhật tài liệu này.

### 3.1. Trách nhiệm các thành phần

| File/thành phần                                              | Trách nhiệm                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firmware/sensor_node/OfflineQueue.h`                        | Khai báo API hàng đợi: khởi tạo, thêm bản ghi, xem bản ghi đầu, xác nhận xóa, đếm bản ghi, kiểm tra hàng đợi đầy và lấy thông báo lỗi.                                                                               |
| `firmware/sensor_node/OfflineQueue.cpp`                      | Cài đặt hàng đợi LittleFS; kiểm tra JSON và ID bản tin; chống bản ghi trùng; giới hạn dung lượng; phục hồi file chính/tạm/backup và xử lý file lỗi.                                                                  |
| `firmware/sensor_node/MqttSyncManager.h/.cpp`                | Quản lý gửi telemetry qua MQTT, đăng ký topic ACK, retry khi timeout/mất ACK và chỉ xác nhận xóa bản ghi khi ACK hợp lệ. Hỗ trợ xác thực ACK theo cả định dạng legacy (`eventId`) và định dạng hiện hành (`msg_id`). |
| `firmware/sensor_node/TelemetryMessage.h/.cpp`               | Định nghĩa cấu trúc mẫu đo và tạo payload telemetry theo định dạng hiện hành để đưa vào hàng đợi.                                                                                                                    |
| `firmware/sensor_node/SensorDrivers.h/.cpp`                  | Khởi tạo và đọc dữ liệu từ các cảm biến được tích hợp trên Sensor Node.                                                                                                                                              |
| `firmware/sensor_node/sensor_node.ino`                       | Sketch chính khởi tạo cảm biến, OLED, LittleFS, OfflineQueue, MqttSyncManager, Wi-Fi/MQTT; đưa mẫu đo vào hàng đợi và điều phối đồng bộ trong vòng lặp chính.                                                        |
| `firmware/sensor_node/offline_sync/` và `firmware/common/`   | Chứa các bản triển khai OfflineQueue/MqttSyncManager cũ; chưa phải nguồn mã được sketch Sensor Node chính include.                                                                                                   |
| `firmware/sensor_node/offline_sync/offline_sync_example.ino` | Đây là payload minh họa theo định dạng cũ mà backend normalizer vẫn hỗ trợ. Sketch Sensor Node chính hiện sử dụng SensorDrivers để đọc dữ liệu cảm biến và TelemetryMessage để tạo payload theo định dạng hiện hành. Payload cũ vẫn được backend hỗ trợ nhằm duy trì khả năng tương thích.dụng.                                                                                                                |
| `telemetry-pipeline.js`                                      | Điều phối luồng telemetry từ MQTT: chuẩn hóa dữ liệu, kiểm tra thiết bị/topic, gọi xử lý lưu trữ trong transaction và gửi ACK sau khi lưu thành công.                                                                |
| `telemetry-ingestion.service.js`                             | Cung cấp logic tiếp nhận telemetry, kiểm tra dữ liệu và xử lý kết quả lưu/nhận diện bản tin trùng.                                                                                                                   |
| `telemetry-ingestion.repository.pg.js`                       | Thao tác với PostgreSQL; lưu telemetry, xử lý trùng theo thiết bị và mã bản tin, cập nhật dữ liệu mới nhất và tạo sự kiện `telemetry.stored`.                                                                        |
| `telemetry-normalizer.js`                                    | Chuẩn hóa payload theo định dạng hiện hành hoặc định dạng cũ; kiểm tra cấu trúc, kiểu dữ liệu và tạo hash nội dung.                                                                                                  |
| `dynamic-security.js`                                        | Giao tiếp với MQTT Dynamic Security để quản lý identity và role của backend/thiết bị trong broker.                                                                                                                   |
| `tests/integration/telemetry.test.js`                        | Kiểm thử tích hợp luồng MQTT → backend → PostgreSQL → ACK và các trường hợp lỗi liên quan.                                                                                                                           |
| `tests/helpers/database.js`, `tests/helpers/iot.js`          | Chuẩn bị database/schema riêng, MQTT identity, thiết bị và fixture phục vụ integration test.                                                                                                                         |
| `deployment/compose.yml`                                     | Khai báo PostgreSQL và MQTT broker, bao gồm các dịch vụ dành riêng cho môi trường test.                                                                                                                              |
| `package.json`                                               | Khai báo các lệnh chạy test và bootstrap MQTT broker.                                                                                                                                                                |
| `.github/workflows/firmware.yml`                             | Cài đặt Arduino CLI, ESP32 Arduino Core và thư viện; tạo `Config.h` từ file mẫu rồi biên dịch Sensor Node và Control Node trên GitHub Actions.                                                                       |

## 4. Cấu trúc dữ liệu và giao tiếp

### 4.1. Payload telemetry dạng cũ trong firmware minh họa

```json
{
  "messageType": "telemetry",
  "eventId": "SENSOR_01-BOOT1-ABC-1",
  "deviceId": "SENSOR_01",
  "roomCode": "ROOM_302",
  "timestamp": "2026-10-28T09:59:55Z",
  "temperatureC": 27.5,
  "humidityPercent": 65,
  "illuminanceLux": 320
}
````

Đây là payload minh họa theo định dạng cũ mà backend normalizer vẫn hỗ trợ. Các giá trị cảm biến trong sketch minh họa `offline_sync_example.ino` là dữ liệu mẫu; sketch Sensor Node chính hiện sử dụng `SensorDrivers` để đọc dữ liệu cảm biến và `TelemetryMessage` để tạo payload theo định dạng hiện hành.

### 4.2. Payload telemetry theo định dạng hiện hành

```json
{
  "msg_id": "SENSOR_01-BOOT1-ABC-1",
  "device_id": "SENSOR_01",
  "room_id": "ROOM_302",
  "timestamp": 1793181595000,
  "data": {
    "temperature": 27.5,
    "humidity": 65,
    "lux": 320,
    "occupancy": true
  }
}
```

Backend chuẩn hóa cả payload dạng cũ và dạng hiện hành về cùng mô hình xử lý. Với payload dạng cũ không có trường `occupancy`, backend giữ giá trị `NULL`, không tự suy diễn thành `false`.

### 4.3. MQTT topic

**Topic telemetry:**

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry
```

**Topic ACK ứng dụng:**

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry/ack
```

Backend kiểm tra định danh thiết bị và phòng trong payload phải khớp với định danh thể hiện trong topic. Bản tin không khớp bị từ chối và không được ACK `STORED`.

### 4.4. Payload ACK ứng dụng

Ví dụ ACK cho payload dạng cũ:

```json
{
  "messageType": "telemetry_ack",
  "eventId": "SENSOR_01-BOOT1-ABC-1",
  "status": "STORED",
  "duplicate": false,
  "timestamp": "2026-10-28T10:00:00.000Z"
}
```

Với payload theo định dạng hiện hành, backend phát ACK có các trường `msg_id`, `device_id`, `room_id`, `status`, `duplicate` và `timestamp`. Trường `timestamp` của ACK hiện hành là Unix timestamp tính bằng milliseconds; ACK legacy sử dụng timestamp dạng chuỗi ISO.

`MqttSyncManager` trong `firmware/sensor_node/` kiểm tra định dạng ACK phải tương ứng với định dạng bản ghi đang chờ trong queue. Với ACK hiện hành, firmware kiểm tra `msg_id`, `device_id`, `room_id`, `status`, `duplicate` và kiểu dữ liệu của `timestamp`. Với ACK legacy, firmware kiểm tra `messageType`, `eventId`, `status`, `duplicate` và `timestamp`. Cả hai trường hợp đều yêu cầu trạng thái `STORED` và ID phải khớp với bản ghi đang chờ; firmware không xóa bản ghi nếu ACK sai định dạng, sai ID, sai thiết bị/phòng hoặc sai trạng thái.

Backend chỉ publish ACK sau khi hàm ingest trả về sau khi transaction PostgreSQL hoàn tất thành công. Nếu thao tác database thất bại, backend không gửi ACK `STORED` để thiết bị giữ bản ghi và có thể retry.

## 5. Kiểm tra dữ liệu và xử lý lỗi

### 5.1. Backend

- Kiểm tra cấu trúc và kiểu dữ liệu của payload.
- Kiểm tra mã thiết bị, mã phòng và sự khớp nhau giữa payload với topic.
- Kiểm tra giới hạn hợp lệ của nhiệt độ, độ ẩm và độ rọi.
- Phân biệt payload hiện hành và payload cũ; không trộn lẫn hai định dạng.
- Kiểm tra thiết bị, phòng, trạng thái vòng đời và credential trước khi tiếp nhận telemetry.
- Nhận diện bản tin trùng theo thiết bị và mã bản tin. Nếu cùng mã bản tin nhưng nội dung khác, backend từ chối xung đột.
- Thực hiện ghi dữ liệu trong transaction. Nếu ghi database thất bại, không gửi ACK `STORED`.
- Phân biệt dữ liệu bù offline, dữ liệu lệch đồng hồ và dữ liệu mới nhất.
- Ghi nhận các bản tin cảm biến không hợp lệ; sau năm bản tin cảm biến không hợp lệ liên tiếp, thiết bị đang `ACTIVE` có thể được chuyển sang trạng thái `FAULT` theo logic hiện tại.

### 5.2. Firmware

- Kiểm tra bản ghi JSON và trường ID bản tin (`msg_id` hoặc `eventId` tùy định dạng).
- Không cho phép thêm ID bản tin đã tồn tại trong hàng đợi.
- Không ghi đè bản ghi cũ khi hàng đợi đầy.
- Chỉ xóa bản ghi sau khi nhận ACK ứng dụng hợp lệ, đúng định dạng, đúng ID và có trạng thái `STORED`.
- Dùng file tạm và file backup khi viết lại hàng đợi sau khi xác nhận bản ghi.
- Khi khởi tạo, kiểm tra và phục hồi các file hàng đợi; nếu phát hiện tình trạng lỗi không thể phục hồi an toàn thì dừng khởi tạo để tránh ghi đè dữ liệu cần bảo toàn.

## 6. Kiểm thử và kết quả

### 6.1. Integration test backend

Lệnh kiểm thử riêng:

```powershell
node --test tests/integration/telemetry.test.js
```

Mã nguồn `tests/integration/telemetry.test.js` hiện có 7 test case. Tài liệu trước đó ghi nhận kết quả PASS của 6 test case đầu; test case thứ 7 đã có trong mã nguồn nhưng chưa có kết quả chạy riêng được xác nhận trong lần cập nhật tài liệu này.

Kết quả được ghi nhận trước đó:

```text
tests 6
suites 0
pass 6
fail 0
cancelled 0
skipped 0
todo 0
```

**Kết quả đã được ghi nhận: 6/6 integration test PASS.** Không suy diễn kết quả 7/7 khi chưa có log chạy mới xác nhận test case thứ 7.

| STT | Trường hợp kiểm thử                                                                                                                                                               | Kết quả                    |
| --: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
|   1 | Telemetry MQTT được commit vào database trước khi ACK; nhiều lần gửi đồng thời cùng bản tin chỉ tạo một bản ghi/sự kiện.                                                          | PASS                       |
|   2 | Khi ghi database thất bại thì không gửi ACK; sau khi khôi phục database, gửi lại thành công và không có dữ liệu ghi dở.                                                           | PASS                       |
|   3 | Dữ liệu backfill giữ nguyên thời điểm đo, không ghi đè dữ liệu mới nhất và không trở thành dữ liệu đủ điều kiện.                                                                  | PASS                       |
|   4 | Payload cũ giữ được lux dạng thập phân và occupancy `NULL`; timestamp thiếu hoặc ở tương lai chỉ đi vào lịch sử, không cập nhật dữ liệu mới nhất.                                 | PASS                       |
|   5 | Payload không khớp topic bị từ chối; năm phép đo không hợp lệ khiến thiết bị chuyển `FAULT`; mẫu hợp lệ vẫn được ghi nhận nhưng không đủ điều kiện xử lý như trạng thái `ACTIVE`. | PASS                       |
|   6 | Thiết bị đã bị thu hồi không thể tiếp tục ingest telemetry; thiết bị khác có thể sử dụng cùng `msg_id` mà không bị coi là trùng toàn hệ thống.                                    | PASS                       |
|   7 | Backfill cũ không tạo dữ liệu latest khi chưa có bản ghi latest.                                                                                                                  | Chưa xác nhận kết quả chạy |

### 6.2. Môi trường integration test

Integration test sử dụng database và MQTT broker riêng, không dùng chung với môi trường phát triển:

- PostgreSQL test: `127.0.0.1:5434`, database `smartclass_test`.
- MQTT test broker: `127.0.0.1:1885`.
- Cấu hình kết nối kiểm thử được đọc từ `.env.test`.
- MQTT test broker cần được bootstrap role/identity trước khi chạy integration test.

Các lệnh đã được tài liệu ghi nhận là sử dụng thành công:

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test
npm run mqtt:bootstrap:test
node --test tests/integration/telemetry.test.js
```

Chạy lệnh tại thư mục gốc repository, nơi có `package.json`, `.env`, `.env.test` và `deployment/compose.yml`. Không chia sẻ nội dung `.env` hoặc `.env.test` vì các file này chứa thông tin bí mật.

### 6.3. Phạm vi chưa được kiểm chứng

Kết quả integration test backend đã ghi nhận xác nhận các kịch bản được liệt kê là PASS chạy qua MQTT test broker và PostgreSQL test. Kết quả này **không đồng nghĩa** với việc đã kiểm thử vật lý toàn bộ cơ chế offline trên ESP32.

Các kiểm thử còn cần thực hiện:

- Xác nhận GitHub Actions workflow biên dịch thành công cho cả Sensor Node và Control Node.
- Ngắt Wi-Fi hoặc MQTT và xác nhận telemetry vẫn được ghi vào LittleFS.
- Khởi động lại ESP32 và xác nhận hàng đợi được phục hồi.
- Khôi phục mạng và xác nhận các bản ghi được gửi lại theo thứ tự.
- Làm mất ACK và xác nhận bản ghi không bị xóa sớm.
- Xác nhận ACK sai ID hoặc sai trạng thái không làm xóa bản ghi.
- Kiểm tra hàng đợi đầy, file lỗi và mất nguồn trong lúc cập nhật file.
- Kiểm tra đầu cuối định dạng payload/ACK thực tế giữa firmware chính và backend.
- Xác nhận kết quả PASS của test case thứ 7 trong `tests/integration/telemetry.test.js`.

## 7. Hạn chế hiện tại

1. **Chưa kiểm thử phần cứng thực tế:** chưa có kết quả xác nhận ESP32 lưu và phục hồi hàng đợi LittleFS qua các tình huống mất mạng, khởi động lại hoặc mất nguồn.
2. **Chưa kiểm thử đầu cuối trên thiết bị thật:** sketch Sensor Node chính đã tích hợp `SensorDrivers`, `OfflineQueue` và `MqttSyncManager`, nhưng chưa có kết quả kiểm chứng toàn bộ luồng từ cảm biến đến backend và ACK trên phần cứng.
3. **Chưa xác nhận GitHub Actions build firmware:** workflow `.github/workflows/firmware.yml` đã được bổ sung; cần kiểm tra kết quả chạy thực tế cho cả hai loại node.
4. **Chưa kiểm thử độ bền dài hạn của flash:** cần đánh giá chu kỳ lấy mẫu, số bản ghi tối đa, dung lượng LittleFS và tần suất ghi/xóa theo điều kiện triển khai.
5. **Cấu hình bảo mật trong sketch còn là ví dụ:** SSID, mật khẩu Wi-Fi, MQTT host và credential cần được cấu hình theo môi trường thật; không đưa secret thật lên repository.
6. **Integration test chỉ bao phủ các kịch bản đã viết:** chưa thay thế kiểm thử tải, kiểm thử độ bền và kiểm thử thực tế trên nhiều Sensor Node.
7. **Còn các bản mã OfflineQueue/MqttSyncManager cũ:** `firmware/common/` và `firmware/sensor_node/offline_sync/` đang chứa các file trùng nội dung với nhau, khác với bộ mã chính tại `firmware/sensor_node/`. Cần xử lý các bản trùng lặp để tránh nhầm lẫn về nguồn mã trong bước chỉnh sửa code tiếp theo.

## 8. Công việc tiếp theo

| STT | Công việc                                                                            | Mục đích/kết quả cần xác nhận                                 |
| --: | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
|   1 | Kiểm thử hàng đợi LittleFS trên ESP32 thật khi mất Wi-Fi, mất MQTT và khởi động lại. | Xác nhận dữ liệu được lưu và phục hồi an toàn.                |
|   2 | Khôi phục kết nối và kiểm tra gửi bù dữ liệu theo thứ tự.                            | Không mất bản ghi chưa được xác nhận.                         |
|   3 | Làm mất ACK, gửi ACK sai ID và ACK sai trạng thái.                                   | Xác nhận thiết bị chỉ xóa bản ghi khi nhận ACK STORED hợp lệ. |
|   4 | Kiểm tra hàng đợi đầy, file lỗi và mất nguồn trong quá trình cập nhật file.          | Đánh giá khả năng bảo toàn dữ liệu.                           |
|   5 | Đánh giá dung lượng hàng đợi và tuổi thọ flash theo chu kỳ gửi telemetry thực tế.    | Xác định giới hạn vận hành phù hợp.                           |
|   6 | Kiểm thử đầu cuối ESP32 → MQTT → Backend → PostgreSQL → ACK → ESP32.                 | Xác nhận tích hợp thực tế trên phần cứng.                     |

## 9. Kết luận và đánh giá trạng thái

ADV-02 đã triển khai các thành phần chính cho cơ chế lưu telemetry khi mất kết nối trên Sensor Node bằng LittleFS. Thiết bị đưa bản ghi vào hàng đợi, gửi lại khi MQTT được khôi phục và chỉ xóa bản ghi khi nhận ACK ứng dụng hợp lệ. Backend tiếp nhận telemetry, kiểm tra dữ liệu, lưu PostgreSQL trong transaction và chỉ gửi ACK STORED sau khi lưu thành công.

Các bản triển khai OfflineQueue và MqttSyncManager trùng lặp đã được loại bỏ. Sensor Node sử dụng bộ triển khai thống nhất tại `firmware/sensor_node/`; các module dùng chung trong `firmware/common/` vẫn được giữ lại.

Về kiểm thử phần mềm, GitHub Actions Backend Checks trên commit `abab893` đạt 106/106 test PASS, bao gồm unit test Node.js 22, Node.js 24, integration test và deployment. GitHub Actions Firmware Build trên commit `6421454` cũng biên dịch thành công cả Sensor Node và Control Node.

Tuy nhiên, chưa có kết quả kiểm thử mất mạng, phục hồi hàng đợi LittleFS và gửi bù telemetry trên ESP32 thật. Vì vậy, kết quả hiện tại xác nhận mức triển khai và kiểm thử phần mềm, chưa xác nhận đầy đủ khả năng vận hành thực tế trên phần cứng.

**Đánh giá:** ADV-02 đã hoàn thành phần triển khai firmware/backend và kiểm thử tự động trong repository. Phần kiểm thử độ bền, phục hồi dữ liệu và đồng bộ đầu cuối trên ESP32 thật vẫn là giới hạn cần thực hiện khi có điều kiện phần cứng.
