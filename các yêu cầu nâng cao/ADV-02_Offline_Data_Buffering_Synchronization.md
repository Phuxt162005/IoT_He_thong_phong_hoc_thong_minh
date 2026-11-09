# ADV-02 — Lưu dữ liệu khi mất mạng và đồng bộ lại

**Tên tiếng Anh:** Offline Data Buffering & Synchronization  
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Phạm vi:** Firmware ESP32 Sensor Node, MQTT và Backend PostgreSQL

## 1. Mục tiêu và phạm vi

ADV-02 xây dựng cơ chế hạn chế mất dữ liệu telemetry khi Sensor Node mất kết nối Wi-Fi hoặc MQTT. Trong thời gian không thể truyền dữ liệu, thiết bị lưu các bản ghi đo vào bộ nhớ flash thông qua LittleFS. Khi kết nối được khôi phục, thiết bị tiếp tục gửi các bản ghi chưa được backend xác nhận.

Backend tiếp nhận telemetry từ MQTT, kiểm tra dữ liệu, lưu vào PostgreSQL và chỉ gửi ACK ứng dụng sau khi thao tác lưu trữ hoàn tất thành công. Mỗi bản tin có mã định danh để nhận diện dữ liệu gửi lại và tránh tạo bản ghi trùng.

Các chức năng chính:

- Lưu telemetry vào hàng đợi LittleFS trước khi gửi MQTT.
- Gán mã định danh cho từng bản ghi.
- Gửi lại các bản ghi chưa được xác nhận khi kết nối được khôi phục.
- Chỉ xóa bản ghi khỏi hàng đợi sau khi nhận ACK ứng dụng hợp lệ có trạng thái `STORED` và mã định danh tương ứng.
- Giới hạn số bản ghi trong hàng đợi, không ghi đè dữ liệu cũ khi hàng đợi đầy.
- Kiểm tra và phục hồi hàng đợi từ file chính, file tạm hoặc file backup khi khởi động.
- Backend kiểm tra payload và đối chiếu định danh thiết bị/phòng với MQTT topic.
- Backend chống trùng bản tin theo thiết bị và mã bản tin.
- Phân biệt dữ liệu lịch sử được gửi bù với dữ liệu mới nhất.
- Không gửi ACK `STORED` nếu transaction lưu dữ liệu thất bại.

## 2. Nguyên lý hoạt động

1. Sensor Node thu thập dữ liệu cảm biến và tạo mã định danh cho bản ghi.
2. Thiết bị ghi bản ghi telemetry vào hàng đợi LittleFS trước khi gửi MQTT.
3. Nếu Wi-Fi hoặc MQTT không khả dụng, bản ghi tiếp tục được giữ trong hàng đợi.
4. Khi kết nối được khôi phục, thiết bị đọc bản ghi chưa được xác nhận ở đầu hàng đợi và publish lên topic telemetry.
5. Backend nhận bản tin MQTT, chuẩn hóa payload và kiểm tra tính hợp lệ cũng như sự khớp nhau giữa định danh trong payload và topic.
6. Backend xử lý dữ liệu trong transaction PostgreSQL: kiểm tra trạng thái thiết bị, kiểm tra mã bản tin trùng, lưu dữ liệu cảm biến và cập nhật dữ liệu mới nhất nếu bản ghi đủ điều kiện.
7. Sau khi transaction hoàn tất thành công, backend gửi ACK ứng dụng với trạng thái `STORED`.
8. ESP32 kiểm tra ACK. Chỉ khi mã định danh khớp và trạng thái là `STORED`, thiết bị mới xác nhận xóa bản ghi tương ứng khỏi hàng đợi.
9. Nếu ACK bị mất, thiết bị gửi lại cùng bản ghi. Backend nhận diện bản tin đã lưu và không tạo thêm dữ liệu trùng.

### 2.1. Cơ chế gửi và xác nhận

Thiết kế sử dụng **at-least-once delivery** ở tầng ứng dụng. Một bản ghi có thể được gửi nhiều lần nếu thiết bị không nhận được ACK. Backend xử lý tính idempotent bằng định danh bản tin theo thiết bị.

MQTT QoS 1 không thay thế ACK ứng dụng. QoS 1 xác nhận việc chuyển giao bản tin ở tầng MQTT, không chứng minh dữ liệu đã được commit thành công vào PostgreSQL. Vì vậy, thiết bị không xóa bản ghi chỉ dựa trên kết quả publish MQTT.

### 2.2. Phân biệt dữ liệu lịch sử và dữ liệu mới nhất

Khi thiết bị kết nối lại, các bản ghi tích lũy trong thời gian mất mạng có thể được gửi sau một bản ghi mới hơn. Backend giữ thời điểm đo của từng bản ghi để phục vụ truy vấn lịch sử.

Bản ghi bù offline (`is_backfill`) vẫn được lưu vào lịch sử, nhưng không ghi đè dữ liệu mới nhất hoặc trở thành dữ liệu đủ điều kiện cho các xử lý phụ thuộc vào trạng thái hiện tại nếu không thỏa điều kiện.

## 3. Cấu trúc mã nguồn

Các thành phần chính liên quan đến ADV-02:

```text
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
│   │   └── control_node.ino
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
│       └── SensorDrivers.h
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
```

`firmware/sensor_node/` chứa bộ triển khai OfflineQueue và MqttSyncManager được sketch Sensor Node chính sử dụng. `firmware/common/` vẫn được giữ cho các module dùng chung như ActuatorManager, NodeSessionManager, OledDisplay, RemoteConfigManager, SensorDrivers và TelemetryMessage. Các bản OfflineQueue/MqttSyncManager trùng lặp trước đây tại `firmware/common/` và `firmware/sensor_node/offline_sync/` không còn nằm trong cây mã nguồn hiện tại.

### 3.1. Trách nhiệm các thành phần

| Thành phần | Trách nhiệm |
|---|---|
| `firmware/sensor_node/OfflineQueue.h/.cpp` | Quản lý hàng đợi LittleFS; thêm, đọc, đếm và xác nhận xóa bản ghi; kiểm tra dữ liệu, chống trùng, giới hạn dung lượng và phục hồi file hàng đợi. |
| `firmware/sensor_node/MqttSyncManager.h/.cpp` | Gửi telemetry qua MQTT, đăng ký topic ACK, retry khi timeout/mất ACK và chỉ xác nhận xóa bản ghi khi ACK hợp lệ. Hỗ trợ định dạng ACK legacy (`eventId`) và hiện hành (`msg_id`). |
| `firmware/sensor_node/TelemetryMessage.h/.cpp` | Định nghĩa cấu trúc mẫu đo và tạo payload telemetry. |
| `firmware/sensor_node/SensorDrivers.h/.cpp` | Khởi tạo và đọc dữ liệu từ cảm biến trên Sensor Node. |
| `firmware/sensor_node/sensor_node.ino` | Sketch chính khởi tạo cảm biến, OLED, LittleFS, OfflineQueue, MqttSyncManager và Wi-Fi/MQTT; đưa mẫu đo vào hàng đợi và điều phối đồng bộ. |
| `firmware/common/` | Chứa các module dùng chung giữa các node; không phải vị trí triển khai OfflineQueue/MqttSyncManager đang được Sensor Node sử dụng. |
| `backend/.../telemetry-pipeline.js` | Điều phối telemetry từ MQTT, gọi xử lý ingest và gửi ACK sau khi lưu thành công. |
| `backend/.../telemetry-ingestion.service.js` | Kiểm tra dữ liệu telemetry và xử lý kết quả lưu/nhận diện bản tin trùng. |
| `backend/.../telemetry-ingestion.repository.pg.js` | Thao tác PostgreSQL, lưu telemetry, xử lý trùng và cập nhật dữ liệu mới nhất. |
| `backend/.../telemetry-normalizer.js` | Chuẩn hóa payload hiện hành và legacy, kiểm tra cấu trúc và kiểu dữ liệu. |
| `tests/integration/telemetry.test.js` | Kiểm thử tích hợp luồng MQTT, backend, PostgreSQL và ACK. |
| `tests/integration/phase3-firmware-sensor.test.js` | Kiểm thử tích hợp các luồng Sensor Node, telemetry ingestion và offline synchronization. |
| `.github/workflows/firmware.yml` | Cài đặt Arduino CLI, ESP32 Arduino Core và thư viện; tạo `Config.h` từ file mẫu rồi biên dịch Sensor Node và Control Node. |

## 4. Cấu trúc dữ liệu và giao tiếp

### 4.1. Payload telemetry legacy

Backend vẫn hỗ trợ payload theo định dạng cũ:

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
```

Đây là định dạng tương thích cũ. Backend normalizer tiếp tục hỗ trợ để xử lý payload legacy.

### 4.2. Payload telemetry hiện hành

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

Backend chuẩn hóa payload legacy và payload hiện hành về mô hình xử lý chung. Với payload legacy không có trường occupancy, backend giữ giá trị `NULL`, không tự suy diễn thành `false`.

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

ACK cho payload legacy có dạng:

```json
{
  "messageType": "telemetry_ack",
  "eventId": "SENSOR_01-BOOT1-ABC-1",
  "status": "STORED",
  "duplicate": false,
  "timestamp": "2026-10-28T10:00:00.000Z"
}
```

Với payload hiện hành, backend phát ACK gồm các trường `msg_id`, `device_id`, `room_id`, `status`, `duplicate` và `timestamp`. Timestamp của ACK hiện hành là Unix timestamp tính bằng milliseconds; ACK legacy sử dụng chuỗi ISO.

Firmware kiểm tra ACK theo định dạng tương ứng với bản ghi đang chờ. Cả hai định dạng đều yêu cầu trạng thái `STORED` và mã định danh khớp với bản ghi đầu hàng đợi. ACK sai định dạng, sai ID, sai thiết bị/phòng hoặc sai trạng thái không được dùng để xóa bản ghi.

Backend chỉ publish ACK sau khi thao tác ingest trả về sau khi transaction PostgreSQL hoàn tất thành công. Nếu database thất bại, backend không gửi ACK `STORED` để thiết bị giữ bản ghi và có thể retry.

## 5. Kiểm tra dữ liệu và xử lý lỗi

### 5.1. Backend

- Kiểm tra cấu trúc và kiểu dữ liệu của payload.
- Kiểm tra mã thiết bị, mã phòng và sự khớp nhau giữa payload với topic.
- Kiểm tra giới hạn hợp lệ của các giá trị cảm biến.
- Hỗ trợ payload hiện hành và payload legacy.
- Kiểm tra thiết bị, phòng, trạng thái vòng đời và credential trước khi tiếp nhận telemetry.
- Nhận diện bản tin trùng theo thiết bị và mã bản tin. Nếu cùng mã bản tin nhưng nội dung khác, backend từ chối xung đột.
- Thực hiện ghi dữ liệu trong transaction. Nếu ghi database thất bại, không gửi ACK `STORED`.
- Phân biệt dữ liệu bù offline, dữ liệu lệch đồng hồ và dữ liệu mới nhất.
- Logic hiện tại có xử lý chuyển thiết bị đang `ACTIVE` sang `FAULT` sau chuỗi bản tin cảm biến không hợp lệ theo ngưỡng được cấu hình.

### 5.2. Firmware

- Kiểm tra bản ghi JSON và trường ID bản tin (`msg_id` hoặc `eventId` tùy định dạng).
- Không cho phép thêm ID bản tin đã tồn tại trong hàng đợi.
- Không ghi đè bản ghi cũ khi hàng đợi đầy.
- Chỉ xóa bản ghi sau khi nhận ACK ứng dụng hợp lệ, đúng định dạng, đúng ID và có trạng thái `STORED`.
- Sử dụng file tạm và file backup khi viết lại hàng đợi sau khi xác nhận bản ghi.
- Khi khởi tạo, kiểm tra và phục hồi các file hàng đợi; nếu phát hiện lỗi không thể phục hồi an toàn thì dừng khởi tạo để tránh ghi đè dữ liệu cần bảo toàn.

## 6. Kiểm thử và kết quả

### 6.1. Backend Checks

GitHub Actions Backend Checks trên commit `abab893` hoàn tất thành công với kết quả tổng hợp **106 tests PASS, 0 FAIL**. Workflow bao gồm:

- Unit tests trên Node.js 22: PASS.
- Unit tests trên Node.js 24: PASS.
- Integration tests: PASS.
- Deployment job: PASS.

Trong bộ integration test, kịch bản Phase 3 về Sensor Node, telemetry ingestion và offline synchronization cũng đã PASS.

### 6.2. Firmware Build

GitHub Actions workflow `ESP32 Firmware Build` trên commit `6421454` hoàn tất thành công:

- Sensor Node: PASS.
- Control Node: PASS.

Kết quả này xác nhận hai firmware biên dịch thành công trong môi trường GitHub Actions với Arduino CLI và ESP32 Arduino Core được khai báo trong workflow. Đây không phải là kết quả kiểm thử vận hành trên phần cứng thật.

### 6.3. Phạm vi kiểm thử phần cứng chưa xác nhận

Các kết quả CI không thay thế kiểm thử vật lý cơ chế offline trên ESP32. Những nội dung chưa có bằng chứng kiểm thử phần cứng gồm:

- Ngắt Wi-Fi hoặc MQTT và xác nhận telemetry tiếp tục được ghi vào LittleFS.
- Khởi động lại ESP32 và xác nhận hàng đợi được phục hồi.
- Khôi phục mạng và xác nhận các bản ghi được gửi lại theo thứ tự.
- Làm mất ACK và xác nhận bản ghi không bị xóa sớm.
- Gửi ACK sai ID hoặc sai trạng thái và xác nhận hàng đợi không xóa nhầm bản ghi.
- Kiểm tra hàng đợi đầy, file lỗi và mất nguồn trong lúc cập nhật file.
- Kiểm thử đầu cuối trên thiết bị thật từ cảm biến đến backend và ACK.

## 7. Hạn chế

1. **Chưa kiểm thử phần cứng thực tế:** Chưa có kết quả xác nhận ESP32 lưu và phục hồi hàng đợi LittleFS qua các tình huống mất mạng, khởi động lại hoặc mất nguồn.
2. **Chưa kiểm thử đầu cuối trên thiết bị thật:** Chưa có kết quả kiểm chứng toàn bộ luồng từ cảm biến đến backend và ACK trên phần cứng thực tế.
3. **Chưa đánh giá độ bền dài hạn của flash:** Cần đánh giá chu kỳ lấy mẫu, số bản ghi tối đa, dung lượng LittleFS và tần suất ghi/xóa trong điều kiện triển khai.
4. **Cấu hình bảo mật trong sketch còn là ví dụ:** SSID, mật khẩu Wi-Fi, MQTT host và credential cần được cấu hình theo môi trường thật; không đưa secret thật lên repository.
5. **Integration test chưa thay thế kiểm thử tải và độ bền:** Các test hiện tại xác nhận những kịch bản đã xây dựng, chưa chứng minh khả năng vận hành dài hạn với nhiều Sensor Node.

## 8. Công việc tiếp theo

| STT | Công việc | Mục đích |
|---:|---|---|
| 1 | Kiểm thử hàng đợi LittleFS trên ESP32 thật khi mất Wi-Fi, mất MQTT và khởi động lại. | Xác nhận dữ liệu được lưu và phục hồi an toàn. |
| 2 | Khôi phục kết nối và kiểm tra gửi bù dữ liệu theo thứ tự. | Không mất bản ghi chưa được xác nhận. |
| 3 | Làm mất ACK, gửi ACK sai ID và ACK sai trạng thái. | Xác nhận thiết bị chỉ xóa bản ghi khi nhận ACK `STORED` hợp lệ. |
| 4 | Kiểm tra hàng đợi đầy, file lỗi và mất nguồn trong quá trình cập nhật file. | Đánh giá khả năng bảo toàn dữ liệu. |
| 5 | Đánh giá dung lượng hàng đợi và tuổi thọ flash theo chu kỳ gửi telemetry thực tế. | Xác định giới hạn vận hành phù hợp. |
| 6 | Kiểm thử đầu cuối ESP32 → MQTT → Backend → PostgreSQL → ACK → ESP32. | Xác nhận tích hợp thực tế trên phần cứng. |

## 9. Kết luận và đánh giá

ADV-02 triển khai cơ chế lưu telemetry khi mất kết nối trên Sensor Node bằng LittleFS. Thiết bị đưa bản ghi vào hàng đợi, gửi lại khi MQTT được khôi phục và chỉ xác nhận xóa bản ghi khi nhận ACK ứng dụng hợp lệ. Backend tiếp nhận telemetry, kiểm tra dữ liệu, lưu PostgreSQL trong transaction và chỉ gửi ACK `STORED` sau khi lưu thành công.

Sensor Node sử dụng bộ triển khai OfflineQueue và MqttSyncManager tại `firmware/sensor_node/`. Các module dùng chung trong `firmware/common/` tiếp tục được giữ lại.

Về kiểm thử phần mềm, Backend Checks trên commit `abab893` đạt 106/106 tests PASS. Firmware Build trên commit `6421454` biên dịch thành công cả Sensor Node và Control Node.

Chưa có kết quả kiểm thử mất mạng, phục hồi hàng đợi LittleFS và gửi bù telemetry trên ESP32 thật. Vì vậy, kết quả hiện tại xác nhận mức triển khai và kiểm thử tự động trong repository, chưa xác nhận đầy đủ khả năng vận hành thực tế trên phần cứng.

**Đánh giá:** ADV-02 đã hoàn thành phần triển khai firmware/backend và kiểm thử tự động trong repository. Kiểm thử độ bền, phục hồi dữ liệu và đồng bộ đầu cuối trên ESP32 thật vẫn là phạm vi cần thực hiện khi có điều kiện phần cứng.
