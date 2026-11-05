# ADV-02 — Lưu dữ liệu khi mất mạng và đồng bộ lại

> **Tên tiếng Anh:** Offline Data Buffering & Synchronization  
> **Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
> **Phạm vi:** Firmware ESP32 (Sensor Node), MQTT và Backend PostgreSQL  
> **Trạng thái tổng hợp:** Đã có mã nguồn hàng đợi offline trên firmware và luồng tiếp nhận telemetry ở backend. Integration test backend đạt **6/6 PASS** theo kết quả được ghi nhận trong tài liệu đầu vào. Chưa xác nhận biên dịch firmware và kiểm thử mất mạng/khôi phục mạng trên ESP32 thật.

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

```text
source code IoT/
├── package.json
├── backend/
│   └── src/
│       ├── mqtt/
│       │   ├── dynamic-security.js
│       │   └── bootstrap-cli.js
│       └── modules/
│           └── telemetry-ingestion/
│               ├── telemetry-pipeline.js
│               ├── telemetry-ingestion.service.js
│               ├── telemetry-ingestion.repository.pg.js
│               └── telemetry-normalizer.js
├── firmware/
│   └── sensor_node/
│       └── offline_sync/
│           ├── OfflineQueue.h
│           ├── OfflineQueue.cpp
│           └── offline_sync_example.ino
├── deployment/
│   ├── compose.yml
│   └── scripts/
│       └── setup-local.mjs
└── tests/
    ├── helpers/
    │   ├── database.js
    │   └── iot.js
    └── integration/
        └── telemetry.test.js
```

### 3.1. Trách nhiệm các thành phần

| File/thành phần | Trách nhiệm |
|---|---|
| `OfflineQueue.h` | Khai báo API hàng đợi: khởi tạo, thêm bản ghi, xem bản ghi đầu, xác nhận xóa, đếm bản ghi, kiểm tra hàng đợi đầy và lấy thông báo lỗi. |
| `OfflineQueue.cpp` | Cài đặt hàng đợi trên hệ thống file; kiểm tra JSON và `eventId`; chống bản ghi trùng; giới hạn dung lượng; phục hồi file chính/tạm/backup. |
| `offline_sync_example.ino` | Sketch minh họa khởi tạo LittleFS, Wi-Fi, MQTT, tạo telemetry, lưu vào hàng đợi, gửi bản ghi chờ và xử lý ACK ứng dụng. |
| `telemetry-pipeline.js` | Điều phối luồng telemetry từ MQTT: chuẩn hóa dữ liệu, kiểm tra thiết bị/topic, gọi xử lý lưu trữ trong transaction và gửi ACK sau khi lưu thành công. |
| `telemetry-ingestion.service.js` | Cung cấp logic tiếp nhận telemetry, kiểm tra dữ liệu và xử lý kết quả lưu/nhận diện bản tin trùng. |
| `telemetry-ingestion.repository.pg.js` | Thao tác với PostgreSQL; lưu telemetry, xử lý trùng theo thiết bị và mã bản tin, cập nhật dữ liệu mới nhất và tạo sự kiện `telemetry.stored`. |
| `telemetry-normalizer.js` | Chuẩn hóa payload theo định dạng hiện hành hoặc định dạng cũ; kiểm tra cấu trúc, kiểu dữ liệu và tạo hash nội dung. |
| `dynamic-security.js` | Giao tiếp với MQTT Dynamic Security để quản lý identity và role của backend/thiết bị trong broker. |
| `tests/integration/telemetry.test.js` | Kiểm thử tích hợp luồng MQTT → backend → PostgreSQL → ACK và các trường hợp lỗi liên quan. |
| `tests/helpers/database.js`, `tests/helpers/iot.js` | Chuẩn bị database/schema riêng, MQTT identity, thiết bị và fixture phục vụ integration test. |
| `deployment/compose.yml` | Khai báo PostgreSQL và MQTT broker, bao gồm các dịch vụ dành riêng cho môi trường test. |
| `package.json` | Khai báo các lệnh chạy test và bootstrap MQTT broker. |

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
```

Đây là payload minh họa theo định dạng cũ mà backend normalizer vẫn hỗ trợ. Các giá trị cảm biến trong sketch hiện là dữ liệu mẫu; cần thay bằng thao tác đọc cảm biến thật khi tích hợp phần cứng.

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

Với payload theo định dạng hiện hành, ACK sử dụng các trường `msg_id`, `device_id`, `room_id`, `status`, `duplicate` và `timestamp`.

**Điểm cần xử lý trước khi tích hợp đầu cuối:** firmware minh họa hiện xử lý ACK theo định dạng cũ (`messageType = telemetry_ack`, `eventId`, `status = STORED`), trong khi backend hỗ trợ cả payload cũ và payload hiện hành. Cần xác nhận định dạng ACK mà backend thực sự phát ra và thống nhất hợp đồng MQTT cuối cùng giữa firmware chính với backend. Không nên mặc định hai định dạng đã tương thích chỉ vì backend hỗ trợ cả hai định dạng telemetry.

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

- Kiểm tra bản ghi JSON và trường `eventId`.
- Không cho phép thêm `eventId` đã tồn tại trong hàng đợi.
- Không ghi đè bản ghi cũ khi hàng đợi đầy.
- Chỉ xóa bản ghi sau khi nhận ACK ứng dụng hợp lệ.
- Dùng file tạm và file backup khi viết lại hàng đợi sau khi xác nhận bản ghi.

## 6. Kiểm thử và kết quả

### 6.1. Integration test backend

Tài liệu đầu vào ghi nhận lệnh kiểm thử:

```powershell
node --test tests/integration/telemetry.test.js
```

Kết quả của lần kiểm thử gần nhất được ghi trong tài liệu:

```text
tests 6
suites 0
pass 6
fail 0
cancelled 0
skipped 0
todo 0
```

**Kết quả được ghi nhận: 6/6 integration test PASS.**

| STT | Trường hợp kiểm thử | Kết quả |
|---:|---|---|
| 1 | Telemetry MQTT được commit vào database trước khi ACK; nhiều lần gửi đồng thời cùng bản tin chỉ tạo một bản ghi/sự kiện. | PASS |
| 2 | Khi ghi database thất bại thì không gửi ACK; sau khi khôi phục database, gửi lại thành công và không có dữ liệu ghi dở. | PASS |
| 3 | Dữ liệu backfill giữ nguyên thời điểm đo, không ghi đè dữ liệu mới nhất và không trở thành dữ liệu đủ điều kiện. | PASS |
| 4 | Payload cũ giữ được lux dạng thập phân và occupancy `NULL`; timestamp thiếu hoặc ở tương lai chỉ đi vào lịch sử, không cập nhật dữ liệu mới nhất. | PASS |
| 5 | Payload không khớp topic bị từ chối; năm phép đo không hợp lệ khiến thiết bị chuyển `FAULT`; mẫu hợp lệ vẫn được ghi nhận nhưng không đủ điều kiện xử lý như trạng thái `ACTIVE`. | PASS |
| 6 | Thiết bị đã bị thu hồi không thể tiếp tục ingest telemetry; thiết bị khác có thể sử dụng cùng `msg_id` mà không bị coi là trùng toàn hệ thống. | PASS |

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

Kết quả 6/6 xác nhận các kịch bản integration test backend đã chạy qua MQTT test broker và PostgreSQL test. Kết quả này **không đồng nghĩa** với việc đã kiểm thử vật lý toàn bộ cơ chế offline trên ESP32.

Các kiểm thử còn cần thực hiện:

- Biên dịch sketch bằng ESP32 Arduino Core và các thư viện tương ứng.
- Thay hàm đọc dữ liệu mẫu bằng driver cảm biến thực tế.
- Ngắt Wi-Fi hoặc MQTT và xác nhận telemetry vẫn được ghi vào LittleFS.
- Khởi động lại ESP32 và xác nhận hàng đợi được phục hồi.
- Khôi phục mạng và xác nhận các bản ghi được gửi lại theo thứ tự.
- Làm mất ACK và xác nhận bản ghi không bị xóa sớm.
- Xác nhận ACK sai `eventId` hoặc sai trạng thái không làm xóa bản ghi.
- Kiểm tra hàng đợi đầy, file lỗi và mất nguồn trong lúc cập nhật file.
- Kiểm tra định dạng payload/ACK thực tế giữa firmware và backend sau khi hợp đồng MQTT của nhóm được chốt.

## 7. Hạn chế hiện tại

1. **Chưa kiểm thử phần cứng thực tế:** chưa có kết quả xác nhận ESP32 lưu và phục hồi hàng đợi LittleFS qua các tình huống mất mạng, khởi động lại hoặc mất nguồn.
2. **Cảm biến trong sketch vẫn là dữ liệu mẫu:** hàm `readSensorValues()` chưa được thay bằng thao tác đọc cảm biến thực tế.
3. **Chưa xác nhận biên dịch firmware:** cảnh báo trong VS Code có thể do cấu hình IntelliSense hoặc thiếu thư viện/toolchain; cần kết quả Verify/biên dịch bằng ESP32 Arduino Core để kết luận.
4. **Cần thống nhất payload và ACK:** backend hỗ trợ payload cũ và payload hiện hành, trong khi sketch minh họa đang xử lý ACK theo định dạng cũ. Cần chốt hợp đồng giao tiếp trước khi tích hợp đầu cuối.
5. **Chưa kiểm thử độ bền dài hạn của flash:** cần đánh giá chu kỳ lấy mẫu, số bản ghi tối đa, dung lượng LittleFS và tần suất ghi/xóa theo điều kiện triển khai.
6. **Cấu hình bảo mật trong sketch còn là ví dụ:** SSID, mật khẩu Wi-Fi, MQTT host và credential cần được cấu hình theo môi trường thật; không đưa secret thật lên repository.
7. **Integration test chỉ bao phủ các kịch bản đã viết:** chưa thay thế kiểm thử tải, kiểm thử độ bền và kiểm thử thực tế trên nhiều Sensor Node.

## 8. Công việc tiếp theo

| STT | Công việc | Mục đích/kết quả cần xác nhận |
|---:|---|---|
| 1 | Thống nhất định dạng telemetry và ACK giữa firmware với backend. | Hai phía sử dụng cùng hợp đồng MQTT. |
| 2 | Thay dữ liệu cảm biến mẫu bằng đọc cảm biến thực tế. | Firmware lưu dữ liệu đo thực tế vào hàng đợi. |
| 3 | Biên dịch sketch với đúng board ESP32 và thư viện cần thiết. | Có kết quả biên dịch xác nhận. |
| 4 | Kiểm thử hàng đợi LittleFS trên ESP32 thật: mất Wi-Fi, mất MQTT, khởi động lại, hàng đợi đầy. | Xác nhận khả năng lưu và phục hồi dữ liệu trên thiết bị. |
| 5 | Kiểm tra chỉ xóa bản ghi sau ACK `STORED` có mã định danh tương ứng. | Không mất bản ghi khi ACK sai hoặc bị mất. |
| 6 | Kiểm thử đầu cuối ESP32 → MQTT → backend → PostgreSQL → ACK → ESP32. | Xác nhận tích hợp thực tế giữa firmware và backend. |
| 7 | Đánh giá dung lượng hàng đợi và tuổi thọ flash theo chu kỳ gửi telemetry thực tế. | Xác định giới hạn vận hành phù hợp. |
| 8 | Bảo đảm credential và cấu hình kết nối được quản lý an toàn. | Không để lộ thông tin bí mật trong source code/repository. |

## 9. Kết luận và đánh giá trạng thái

ADV-02 đã có các thành phần chính cho cơ chế lưu telemetry offline trên ESP32 bằng LittleFS và tiếp nhận, lưu trữ, chống trùng telemetry ở backend. Backend sử dụng PostgreSQL transaction và chỉ gửi ACK ứng dụng sau khi dữ liệu được commit thành công. Cơ chế này cho phép thiết bị gửi lại bản tin khi không nhận được ACK mà không tạo dữ liệu trùng.

Ở mức kiểm thử phần mềm, integration test của luồng telemetry được ghi nhận đạt **6/6 PASS** với PostgreSQL test và MQTT test broker. Các kịch bản đã kiểm tra gồm lưu trước ACK, retry khi database lỗi, backfill, tương thích payload cũ, từ chối dữ liệu sai và kiểm soát thiết bị bị thu hồi.

Tuy nhiên, firmware chưa có kết quả biên dịch được xác nhận và chưa được kiểm thử mất mạng/khôi phục mạng trên ESP32 thật. Đặc biệt, cần thay dữ liệu cảm biến mẫu và thống nhất định dạng ACK giữa firmware với backend trước khi kiểm thử đầu cuối.

**Đánh giá:** Có thể xác nhận phần integration test backend của ADV-02 theo kết quả được ghi nhận; chưa đủ cơ sở kết luận ADV-02 đã hoàn tất kiểm thử đầu cuối trên phần cứng.
