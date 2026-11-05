# HƯỚNG DẪN THỰC HIỆN, VẬN HÀNH VÀ KIỂM THỬ 5 CHỨC NĂNG NÂNG CAO

**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Phạm vi:** ADV-01 đến ADV-05  
**Loại tài liệu:** Hướng dẫn thực hành dành cho thành viên phát triển, tích hợp và kiểm thử hệ thống.

---

## Mục lục

1. [Mục đích và phạm vi](#1-mục-đích-và-phạm-vi)
2. [Tổng quan 5 chức năng](#2-tổng-quan-5-chức-năng)
3. [Chuẩn bị môi trường](#3-chuẩn-bị-môi-trường)
4. [Quy trình làm việc chung](#4-quy-trình-làm-việc-chung)
5. [ADV-01 — Digital Twin / Device Shadow](#5-adv-01--digital-twin--device-shadow)
6. [ADV-02 — Offline Data Buffering & Synchronization](#6-adv-02--offline-data-buffering--synchronization)
7. [ADV-03 — Monitoring và Logging tập trung](#7-adv-03--monitoring-và-logging-tập-trung)
8. [ADV-04 — Phát hiện dữ liệu môi trường bất thường](#8-adv-04--phát-hiện-dữ-liệu-môi-trường-bất-thường)
9. [ADV-05 — Cập nhật firmware từ xa (OTA)](#9-adv-05--cập-nhật-firmware-từ-xa-ota)
10. [Quy trình kiểm thử tích hợp 5 chức năng](#10-quy-trình-kiểm-thử-tích-hợp-5-chức-năng)
11. [Bảng tổng hợp lệnh chạy và kiểm thử](#11-bảng-tổng-hợp-lệnh-chạy-và-kiểm-thử)
12. [Xử lý lỗi và lưu ý vận hành](#12-xử-lý-lỗi-và-lưu-ý-vận-hành)
13. [Checklist nghiệm thu](#13-checklist-nghiệm-thu)
14. [Kết luận](#14-kết-luận)

---

## 1. Mục đích và phạm vi

Tài liệu này hướng dẫn cách tiếp cận, thực hiện, khởi chạy và kiểm thử năm chức năng nâng cao của hệ thống phòng học thông minh:

- **ADV-01:** Digital Twin / Device Shadow.
- **ADV-02:** Lưu dữ liệu khi mất mạng và đồng bộ lại.
- **ADV-03:** Monitoring và Logging tập trung.
- **ADV-04:** Phát hiện dữ liệu môi trường bất thường.
- **ADV-05:** Cập nhật firmware từ xa (OTA).

Nội dung được tổng hợp từ năm tài liệu mô tả chức năng tương ứng. Vì vậy, tài liệu tập trung vào cấu trúc source code, luồng xử lý, cơ sở dữ liệu, giao tiếp, lệnh chạy và các trường hợp kiểm thử đã được mô tả.

### 1.1. Cách đọc trạng thái triển khai

Trong quá trình làm và kiểm thử, cần phân biệt ba mức sau:

| Mức | Ý nghĩa |
|---|---|
| Đã có mã nguồn/module | Chức năng đã có thành phần xử lý trong repository. |
| Đã có kiểm thử tự động | Có test case cho nghiệp vụ; chỉ kết luận PASS khi lệnh kiểm thử thực sự chạy thành công. |
| Đã kiểm thử tích hợp/phần cứng | Đã kiểm tra luồng phối hợp giữa các thành phần hoặc trên thiết bị thật. Không suy ra mức này từ unit test hay mock test. |

**Nguyên tắc:** Không đánh dấu một chức năng hoàn tất toàn hệ thống chỉ vì module đã có mã nguồn hoặc test tự động đã PASS. Cần ghi rõ phạm vi đã kiểm chứng và phần còn thiếu.

### 1.2. Phạm vi không được mặc định

Các tài liệu đầu vào chưa xác nhận đầy đủ giao diện dashboard cho ADV-01, ADV-03, ADV-04 và giao diện quản lý OTA. Một số kiểm thử dùng repository in-memory, mock hoặc MQTT broker/database dành riêng cho test. Firmware minh họa của ADV-02 còn cần thống nhất định dạng ACK với Backend. ADV-05 chưa có bằng chứng OTA chạy thành công trên ESP32 thật.

Các nội dung này được đánh dấu tại từng chức năng, không được coi là đã hoàn thành.

---

## 2. Tổng quan 5 chức năng

| Mã | Chức năng | Thành phần chính | Kết quả cần quan sát |
|---|---|---|---|
| ADV-01 | Digital Twin / Device Shadow | Backend Commands, Device Shadow, PostgreSQL, MQTT, Control Node | Desired State, Reported State, phiên bản, `in_sync`, `differences`, trạng thái command |
| ADV-02 | Offline Data Buffering & Synchronization | Sensor Node ESP32, LittleFS, MQTT, Telemetry Ingestion, PostgreSQL | Bản ghi được lưu khi offline, gửi bù khi online, ACK `STORED`, không sinh dữ liệu trùng |
| ADV-03 | Monitoring và Logging | LoggingService, MonitoringService, repository, MQTT runtime, PostgreSQL | Log JSON, che dữ liệu nhạy cảm, trạng thái component/device, heartbeat, counter, snapshot |
| ADV-04 | Phát hiện dữ liệu môi trường bất thường | AnomalyDetectionService, Consumer, PostgreSQL | `WARMING_UP`, `NORMAL`, `ANOMALY`, baseline và kết quả phân tích |
| ADV-05 | OTA | OTA Service, PostgreSQL, firmware storage, MQTT, thiết bị IoT | Firmware `DRAFT/PUBLISHED/REVOKED`, OTA Job, tiến độ và kết quả cập nhật |

### 2.1. Quan hệ giữa các chức năng

Một luồng tích hợp điển hình có thể được hiểu như sau:

1. Sensor Node thu thập dữ liệu môi trường.
2. Nếu mất mạng, ADV-02 lưu dữ liệu vào LittleFS; khi có mạng, thiết bị gửi lại dữ liệu chưa được xác nhận.
3. Backend tiếp nhận và lưu telemetry. Sự kiện được ghi nhận có thể được sử dụng bởi ADV-03 để thống kê/giám sát và bởi ADV-04 để phân tích bất thường.
4. Với Control Node, ADV-01 quản lý trạng thái mong muốn và trạng thái thực tế khi điều khiển đèn/quạt.
5. ADV-05 quản lý vòng đời bản firmware và yêu cầu cập nhật từ xa cho thiết bị tương thích.

Đây là quan hệ nghiệp vụ giữa các module; từng điểm tích hợp đầu cuối vẫn phải được kiểm thử riêng.

---

## 3. Chuẩn bị môi trường

### 3.1. Kiểm tra cấu trúc repository

Mở terminal tại thư mục gốc repository — nơi có `package.json`. Kiểm tra các thư mục và file liên quan:

```text
database/
  migrations/
backend/
  src/
    modules/
tests/
firmware/
deployment/
package.json
```

Các thư mục cụ thể của từng ADV được liệt kê ở phần hướng dẫn tương ứng. Không tự tạo lại file hoặc thư mục nếu repository đã có cấu trúc tương ứng.

### 3.2. Công cụ và dịch vụ cần có

| Công cụ/dịch vụ | Mục đích |
|---|---|
| Node.js và npm | Chạy Backend và các bộ kiểm thử Node.js |
| PostgreSQL | Lưu dữ liệu nghiệp vụ, trạng thái, baseline, kết quả và OTA Job |
| MQTT broker (ví dụ Mosquitto) | Truyền telemetry, command, ACK và trạng thái OTA |
| Docker Compose | Khởi chạy các dịch vụ database/MQTT trong môi trường test theo cấu hình repository |
| ESP32 Arduino Core và thư viện liên quan | Biên dịch, nạp và kiểm thử firmware khi thực hiện phần cứng |
| Công cụ gửi HTTP request | Gọi API Backend trong các bước kiểm tra API |

Tài liệu nguồn không quy định một phiên bản Node.js, PostgreSQL, Mosquitto hoặc ESP32 Arduino Core duy nhất. Sử dụng phiên bản và cấu hình được khai báo trong repository/môi trường của nhóm; không tự suy đoán phiên bản.

### 3.3. Kiểm tra package scripts

Tại thư mục gốc repository, có thể xem các script được khai báo bằng:

```powershell
npm run
```

Các script liên quan đến năm chức năng được tổng hợp ở phần 11. Nếu một script không xuất hiện trong `package.json` của nhánh đang sử dụng, cần kiểm tra lại đúng nhánh/phiên bản source trước khi chạy.

### 3.4. Cấu hình môi trường

1. Kiểm tra các file cấu hình môi trường mà repository yêu cầu.
2. Điền thông tin kết nối PostgreSQL, MQTT broker và các khóa cần thiết theo cấu hình local.
3. Đảm bảo database và MQTT broker đang chạy trước khi chạy các bài integration test cần hai dịch vụ này.
4. Không đưa mật khẩu, token, private key, credential hoặc nội dung `.env` lên GitHub hay chia sẻ trong log/ảnh chụp.
5. Không dùng database đang chứa dữ liệu thật để chạy test có thao tác tạo/xóa dữ liệu. ADV-02 có cấu hình database và MQTT test riêng; cần giữ đúng môi trường test được mô tả.

### 3.5. Nguyên tắc khởi chạy

Không có một lệnh duy nhất được năm tài liệu xác nhận là khởi chạy toàn bộ hệ thống và tất cả chức năng. Vì vậy:

- Chạy migration cần thiết trước khi kiểm tra các bảng tương ứng.
- Khởi chạy PostgreSQL và MQTT broker theo cấu hình repository khi bài test yêu cầu.
- Khởi chạy Backend theo script hiện có của repository.
- Chạy riêng từng bộ test ADV để khoanh vùng lỗi.
- Chỉ kiểm thử thiết bị thật sau khi firmware, topic, payload, credential và cấu hình mạng đã được thống nhất.

---

## 4. Quy trình làm việc chung

Với mỗi chức năng, nên thực hiện theo trình tự:

1. **Đọc module và hợp đồng dữ liệu:** xác định service, repository, route, bảng dữ liệu, MQTT topic và payload.
2. **Kiểm tra migration:** xác nhận các bảng/cột/index cần thiết đã tồn tại.
3. **Kiểm thử độc lập:** chạy bộ unit test hoặc integration test riêng của chức năng.
4. **Khởi chạy dependency:** bật PostgreSQL/MQTT broker nếu luồng cần các dịch vụ này.
5. **Thử nghiệp vụ:** tạo dữ liệu đầu vào hợp lệ, quan sát phản hồi và dữ liệu lưu.
6. **Thử tình huống lỗi:** dữ liệu sai, mất kết nối, timeout, gửi lặp, sai phiên hoặc sai quyền.
7. **Kiểm tra log và database:** đối chiếu kết quả trả về với trạng thái thực tế được lưu.
8. **Kiểm thử tích hợp:** kiểm tra luồng giữa các module và thiết bị.
9. **Ghi nhận kết quả:** lưu lệnh đã chạy, số test pass/fail, môi trường, thời điểm và phạm vi đã kiểm chứng.

---

## 5. ADV-01 — Digital Twin / Device Shadow

### 5.1. Mục tiêu và nguyên lý

ADV-01 duy trì bản thể số đại diện cho trạng thái của Control Node. Hệ thống quản lý hai nhóm trạng thái:

- **Desired State:** trạng thái mà hệ thống yêu cầu thiết bị đạt được.
- **Reported State:** trạng thái thực tế do thiết bị gửi về Backend.

Hệ thống so sánh hai trạng thái để xác định thiết bị đã đồng bộ hay chưa. Với phiên bản hiện tại, các cơ cấu chấp hành được mô tả là:

- Đèn (`light`): `ON`, `OFF`.
- Quạt (`fan`): `ON`, `OFF`.

`UNKNOWN` biểu thị trạng thái thực tế chưa được xác định.

**Điểm quan trọng:** Khi tạo lệnh, Backend cập nhật Desired State nhưng không tự cập nhật Reported State. Reported State chỉ thay đổi khi nhận phản hồi hợp lệ từ thiết bị.

### 5.2. Source code cần nắm

```text
backend/src/modules/
  device-shadow/
    device-shadow.errors.js
    device-shadow.mqtt.js
    device-shadow.repository.memory.js
    device-shadow.repository.pg.js
    device-shadow.service.js
  commands/
    command-schemas.js
    command-state.js
    commands.routes.js
    commands.service.js

database/migrations/
  008_commands_shadow.sql

tests/
  device-shadow.test.js
  integration/commands.test.js
```

Vai trò chính:

| Thành phần | Công việc |
|---|---|
| `device-shadow.service.js` | Tính chênh lệch và xác định trạng thái đồng bộ |
| `device-shadow.repository.pg.js` | Truy vấn Device Shadow và command trong PostgreSQL |
| `commands.service.js` | Tạo command, cập nhật Desired State, gửi MQTT và xử lý phản hồi |
| `command-state.js` | Cập nhật Reported State, kết thúc command và xử lý ACK đến muộn |
| `command-schemas.js` | Kiểm tra cấu trúc command, ACK và Reported State |
| `008_commands_shadow.sql` | Tạo cấu trúc dữ liệu phục vụ Shadow và command |

### 5.3. Cơ sở dữ liệu và dữ liệu cần kiểm tra

Các bảng chính được mô tả:

- `device_shadows`: Desired State, Reported State, version và thời điểm báo cáo.
- `commands`: lịch sử lệnh, trạng thái, session, version và ACK.
- `actuators`: trạng thái và version theo từng cơ cấu chấp hành.
- `command_idempotency`: chống tạo command trùng khi request được gửi lại.

Ví dụ trạng thái chưa đồng bộ:

```json
{
  "desired_state": {"light": "ON", "fan": "OFF"},
  "reported_state": {"light": "OFF", "fan": "OFF"},
  "desired_version": 2,
  "reported_version": 1
}
```

Kết quả so sánh mong đợi:

```json
{
  "in_sync": false,
  "differences": {
    "light": {"desired": "ON", "reported": "OFF"}
  }
}
```

Khi tất cả thuộc tính khớp nhau, `in_sync` phải là `true` và `differences` là object rỗng.

### 5.4. Quy trình thực hiện nghiệp vụ

**Bước 1 — Khởi tạo thiết bị**

Khi Control Node được đăng ký, Backend tạo Device Shadow. Trạng thái khởi tạo được mô tả:

- Desired State: `light = OFF`, `fan = OFF`.
- Reported State: `light = UNKNOWN`, `fan = UNKNOWN`.
- Desired Version: `1`.
- Reported Version: `0`.

Kiểm tra bản ghi tương ứng trong `device_shadows`.

**Bước 2 — Gửi lệnh điều khiển**

Người dùng hoặc automation yêu cầu thay đổi trạng thái. Backend thực hiện:

1. Validate dữ liệu trạng thái.
2. Kiểm tra quyền và phạm vi thiết bị.
3. Kiểm tra thiết bị, phòng học và kết nối MQTT.
4. Tạo `command_id`.
5. Tăng version của Desired State.
6. Lưu command và các thông tin liên quan trong transaction.
7. Sau khi transaction hoàn tất, publish command qua MQTT.

**Bước 3 — Kiểm tra bản tin MQTT**

Topic điều khiển:

```text
smartclassroom/room/{roomCode}/device/{deviceId}/command
```

Payload command cần có các trường như `command_id`, `device_id`, `room_id`, `session_id`, `shadow_version`, `desired_state`, `timestamp` và `expires_at`.

**Bước 4 — Thiết bị phản hồi**

Thiết bị gửi ACK hoặc Reported State về Backend. Backend kiểm tra mã thiết bị, phòng, session, version và thông tin command. ACK thành công chỉ được chấp nhận khi trạng thái báo cáo khớp trạng thái yêu cầu.

**Bước 5 — Kiểm tra đồng bộ**

Truy vấn Shadow và kiểm tra:

- `desired_state`.
- `reported_state`.
- `desired_version`.
- `reported_version`.
- `in_sync`.
- `differences`.
- Trạng thái command gần nhất.

### 5.5. API liên quan

| Phương thức | Endpoint | Chức năng |
|---|---|---|
| GET | `/devices/:id/shadow` | Truy vấn Device Shadow |
| POST | `/devices/:id/commands` | Tạo lệnh điều khiển |
| GET | `/devices/:id/commands` | Truy vấn lịch sử lệnh |

Các route được khai báo trong `commands.routes.js`. API cần xác thực và quyền tương ứng: `commands:read`, `commands:create`. Sensor Node không được phép truy vấn Device Shadow điều khiển.

Tài liệu nguồn không cung cấp mẫu request HTTP hoàn chỉnh, địa chỉ host, cách lấy token hoặc body schema đầy đủ cho từng endpoint. Khi gọi API, cần đọc schema và middleware hiện có trong source thay vì tự tạo payload theo phỏng đoán.

### 5.6. Chạy kiểm thử

Chạy tại thư mục gốc repository:

```powershell
npm run test:device-shadow
```

Bộ unit test được ghi nhận có 11 trường hợp:

1. Tạo Device Shadow với trạng thái ban đầu.
2. Phát hiện chênh lệch Desired State và Reported State.
3. Xác định `UNKNOWN` là chưa đồng bộ.
4. Lấy thông tin command gần nhất.
5. Báo lỗi khi không tìm thấy Shadow.
6. Chấp nhận trạng thái điều khiển hợp lệ.
7. Từ chối trạng thái điều khiển không hợp lệ.
8. Từ chối Desired State rỗng.
9. Từ chối Desired State không phải object.
10. Tạo MQTT command topic hợp lệ.
11. Từ chối MQTT topic có ký tự không hợp lệ.

Tài liệu nguồn ghi nhận kết quả local: **11/11 test PASS**. Đây là kết quả unit test được người dùng cung cấp, không thay thế kiểm thử đầu cuối trên ESP32/Mosquitto.

### 5.7. Kiểm thử tích hợp cần thực hiện

Trong `tests/integration/commands.test.js` có phạm vi test cho luồng Commands/Shadow, gồm:

- Gửi lệnh MQTT.
- Idempotency.
- Phân quyền.
- ACK sai thứ tự.
- Timeout và ACK đến muộn.
- Lỗi publish.
- Lỗi transaction.
- Thiết bị kết nối lại.
- ACK không hợp lệ.

Khi thực hiện, cần chạy đúng môi trường integration test của repository và ghi nhận kết quả thực tế. Tài liệu nguồn chưa cung cấp kết quả chạy tích hợp local cho bộ test này.

### 5.8. Tiêu chí đạt

- Shadow được tạo với trạng thái ban đầu đúng.
- Gửi command làm thay đổi Desired State và tăng version.
- Reported State không thay đổi chỉ vì Backend publish thành công.
- ACK/Reported State sai thiết bị, session hoặc version bị từ chối.
- Khi thiết bị báo đúng trạng thái, Shadow chuyển sang đồng bộ.
- ACK lặp/đến muộn không làm sai kết quả cuối cùng của command.

### 5.9. Giới hạn cần ghi nhận

Chưa có xác nhận đầu cuối với ESP32 và Mosquitto thật, cũng chưa xác nhận dashboard hiển thị đầy đủ Desired/Reported State. Cần kiểm tra riêng phần firmware gửi ACK và Reported State đúng hợp đồng MQTT.

---

## 6. ADV-02 — Offline Data Buffering & Synchronization

### 6.1. Mục tiêu và nguyên lý

ADV-02 hạn chế mất telemetry khi Sensor Node mất Wi-Fi hoặc MQTT. ESP32 lưu bản ghi vào LittleFS trước khi gửi. Khi mạng phục hồi, thiết bị gửi lại các bản ghi chưa được Backend xác nhận.

Backend chỉ gửi ACK ứng dụng `STORED` sau khi transaction ghi dữ liệu PostgreSQL hoàn tất thành công. Thiết bị chỉ xóa bản ghi khỏi hàng đợi khi nhận ACK hợp lệ có đúng mã định danh và trạng thái `STORED`.

Cơ chế được mô tả là **at-least-once delivery**: một bản ghi có thể được gửi nhiều lần nếu ACK bị mất; Backend chống trùng theo thiết bị và mã bản tin.

### 6.2. Source code cần nắm

```text
firmware/sensor_node/offline_sync/
  OfflineQueue.h
  OfflineQueue.cpp
  offline_sync_example.ino

backend/src/
  mqtt/
    dynamic-security.js
    bootstrap-cli.js
  modules/telemetry-ingestion/
    telemetry-pipeline.js
    telemetry-ingestion.service.js
    telemetry-ingestion.repository.pg.js
    telemetry-normalizer.js

tests/integration/
  telemetry.test.js

deployment/
  compose.yml
  scripts/setup-local.mjs
```

| Thành phần | Công việc |
|---|---|
| `OfflineQueue.h/.cpp` | Quản lý hàng đợi LittleFS, kiểm tra JSON/ID, giới hạn dung lượng và phục hồi file |
| `offline_sync_example.ino` | Sketch minh họa lưu, gửi lại telemetry và xử lý ACK |
| `telemetry-pipeline.js` | Điều phối MQTT → kiểm tra/chuẩn hóa → transaction → ACK |
| `telemetry-ingestion.service.js` | Xử lý nghiệp vụ tiếp nhận telemetry |
| `telemetry-ingestion.repository.pg.js` | Lưu dữ liệu, chống trùng và cập nhật dữ liệu mới nhất |
| `telemetry-normalizer.js` | Chuẩn hóa payload hiện hành và payload cũ |

### 6.3. Quy trình hoạt động

**Bước 1 — Tạo bản ghi telemetry**

Sensor Node đọc dữ liệu cảm biến, tạo mã định danh duy nhất cho bản ghi. Payload hiện hành được mô tả:

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

Firmware minh họa cũng có payload dạng cũ với `eventId`, `deviceId`, `roomCode`, `temperatureC`, `humidityPercent` và `illuminanceLux`. Backend normalizer hỗ trợ cả hai dạng.

**Bước 2 — Ghi vào LittleFS trước khi gửi**

Không gửi telemetry trước rồi mới lưu. Bản ghi cần được đưa vào hàng đợi offline trước khi publish MQTT. Nếu mất mạng, bản ghi vẫn còn trên flash.

**Bước 3 — Gửi bản ghi chờ**

Khi MQTT kết nối, thiết bị đọc bản ghi chưa được xác nhận ở đầu hàng đợi và publish lên topic telemetry:

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry
```

**Bước 4 — Backend tiếp nhận và lưu**

Backend kiểm tra payload, topic, thiết bị, phòng, trạng thái thiết bị và mã bản tin. Dữ liệu được ghi trong transaction PostgreSQL. Nếu transaction thất bại, không gửi ACK `STORED`.

**Bước 5 — Backend trả ACK ứng dụng**

Topic ACK:

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry/ack
```

Ví dụ ACK theo payload dạng cũ:

```json
{
  "messageType": "telemetry_ack",
  "eventId": "SENSOR_01-BOOT1-ABC-1",
  "status": "STORED",
  "duplicate": false,
  "timestamp": "2026-10-28T10:00:00.000Z"
}
```

Với payload hiện hành, ACK sử dụng các trường `msg_id`, `device_id`, `room_id`, `status`, `duplicate` và `timestamp`.

**Bước 6 — Xóa bản ghi đã được xác nhận**

ESP32 chỉ xóa bản ghi khi ACK có mã định danh tương ứng và `status = STORED`. MQTT QoS 1 không thay thế ACK ứng dụng và không phải bằng chứng dữ liệu đã được commit vào PostgreSQL.

### 6.4. Cấu hình môi trường integration test

Tài liệu nguồn mô tả môi trường test riêng:

- PostgreSQL test: `127.0.0.1:5434`, database `smartclass_test`.
- MQTT test broker: `127.0.0.1:1885`.
- Cấu hình đọc từ `.env.test`.
- MQTT test broker cần bootstrap role/identity trước khi chạy integration test.

Các lệnh được ghi nhận:

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test
npm run mqtt:bootstrap:test
node --test tests/integration/telemetry.test.js
```

Chạy tại thư mục gốc repository. Cần bảo đảm `.env`, `.env.test` và `deployment/compose.yml` đúng với cấu hình local. Không chia sẻ nội dung file môi trường.

### 6.5. Kiểm thử Backend

Có thể chạy trực tiếp:

```powershell
node --test tests/integration/telemetry.test.js
```

Tài liệu nguồn ghi nhận **6/6 integration test PASS**. Sáu nhóm tình huống gồm:

1. Telemetry được commit vào database trước ACK; gửi đồng thời cùng bản tin không tạo bản ghi/sự kiện trùng.
2. Database lỗi thì không ACK; sau khi khôi phục, gửi lại thành công và không có dữ liệu ghi dở.
3. Backfill giữ thời điểm đo, không ghi đè dữ liệu mới nhất.
4. Payload cũ được chuẩn hóa đúng; timestamp thiếu/tương lai không cập nhật dữ liệu mới nhất.
5. Payload không khớp topic bị từ chối; xử lý dữ liệu không hợp lệ và trạng thái FAULT theo logic hiện tại.
6. Thiết bị bị thu hồi không thể tiếp tục ingest; cùng `msg_id` ở thiết bị khác không bị coi là trùng toàn hệ thống.

### 6.6. Kiểm thử firmware trên ESP32

Các bước dưới đây là phần cần thực hiện để xác nhận firmware thực tế; tài liệu nguồn chưa xác nhận đã hoàn thành:

1. Mở sketch `firmware/sensor_node/offline_sync/offline_sync_example.ino` trong môi trường Arduino phù hợp.
2. Chọn đúng board ESP32 và cấu hình cổng nạp.
3. Kiểm tra thư viện LittleFS, Wi-Fi và MQTT được cài đúng.
4. Thay dữ liệu cảm biến mẫu bằng thao tác đọc cảm biến thực tế.
5. Cấu hình Wi-Fi, MQTT host và credential theo môi trường test.
6. Biên dịch sketch và ghi nhận kết quả Verify.
7. Nạp firmware lên ESP32.
8. Cho thiết bị kết nối và xác nhận telemetry được gửi, Backend lưu và ACK.
9. Ngắt Wi-Fi hoặc MQTT, tạo thêm telemetry và xác nhận hàng đợi tăng.
10. Khởi động lại ESP32 khi còn bản ghi chờ; xác nhận hàng đợi được phục hồi.
11. Khôi phục mạng; xác nhận bản ghi được gửi lại và chỉ bị xóa sau ACK `STORED` đúng ID.
12. Thử ACK sai ID, sai trạng thái hoặc mất ACK; xác nhận bản ghi không bị xóa sớm.
13. Thử hàng đợi đầy và mất nguồn trong lúc cập nhật file để đánh giá khả năng phục hồi.

### 6.7. Vấn đề cần xử lý trước kiểm thử đầu cuối

Firmware minh họa hiện xử lý ACK theo định dạng cũ (`messageType`, `eventId`, `status`), trong khi Backend hỗ trợ cả payload telemetry cũ và hiện hành. Cần xác nhận chính xác định dạng ACK Backend phát ra và thống nhất hợp đồng MQTT giữa firmware chính và Backend. Không mặc định hai bên tương thích chỉ vì Backend hỗ trợ hai định dạng telemetry.

### 6.8. Tiêu chí đạt

- Telemetry được ghi vào LittleFS trước khi gửi.
- Mất Wi-Fi/MQTT không làm mất bản ghi đã đưa vào hàng đợi.
- ESP32 khởi động lại vẫn phục hồi được hàng đợi.
- Bản ghi được gửi lại khi mạng phục hồi.
- Chỉ ACK ứng dụng `STORED` đúng ID mới làm bản ghi được xóa.
- Gửi lặp không tạo dữ liệu trùng trong PostgreSQL.
- Dữ liệu backfill được giữ trong lịch sử nhưng không ghi đè dữ liệu mới nhất.

---

## 7. ADV-03 — Monitoring và Logging tập trung

### 7.1. Mục tiêu và nguyên lý

ADV-03 cung cấp logging có cấu trúc và thông tin monitoring để theo dõi tình trạng Backend, component và thiết bị.

Các mức log:

- `DEBUG`
- `INFO`
- `WARN`
- `ERROR`

Các trạng thái component:

- `UP`
- `DEGRADED`
- `DOWN`
- `UNKNOWN`

Trạng thái thiết bị online/offline được đánh giá từ `connectionStatus` và heartbeat gần nhất. Ngưỡng mặc định trong tài liệu là **60.000 ms (60 giây)**.

### 7.2. Source code cần nắm

```text
backend/src/modules/monitoring-logging/
  monitoring.errors.js
  monitoring.service.js
  monitoring.repository.memory.js
  monitoring.repository.postgres.js
  logging.service.js
  logging.sinks.js

tests/
  monitoring-logging.test.js
```

| Thành phần | Công việc |
|---|---|
| `logging.service.js` | Validate level/message, tạo log JSON, làm sạch metadata và che dữ liệu nhạy cảm |
| `logging.sinks.js` | Console sink và Memory sink |
| `monitoring.service.js` | Trạng thái component, heartbeat trong phạm vi repository hỗ trợ, counter và snapshot |
| `monitoring.repository.memory.js` | Lưu dữ liệu trong bộ nhớ, chủ yếu phục vụ kiểm thử |
| `monitoring.repository.postgres.js` | Lưu component/counter và đọc thiết bị từ PostgreSQL |

### 7.3. Thực hiện Logging

Một bản ghi log có các trường chính:

- `timestamp`
- `level`
- `service`
- `message`
- `metadata`

Quy trình xử lý:

1. Module gọi logger với level, message và metadata.
2. Logger kiểm tra level có được hỗ trợ và message có rỗng hay không.
3. Metadata được làm sạch.
4. Các trường nhạy cảm được nhận diện theo tên khóa, ví dụ `password`, `token`, `secret`, `authorization`, `apiKey`, được thay bằng `[REDACTED]`.
5. Log được chuyển đến sink tương ứng.

Hai sink hiện có:

- `ConsoleLogSink`: ghi JSON ra console.
- `MemoryLogSink`: lưu log trong bộ nhớ phục vụ test/kiểm tra.

**Lưu ý:** Cơ chế che dữ liệu dựa trên tên khóa, không bảo đảm phát hiện mọi thông tin nhạy cảm nằm trong nội dung message tự do.

### 7.4. Thực hiện Monitoring

Các thao tác chính:

1. Cập nhật trạng thái component.
2. Ghi nhận heartbeat trong phạm vi repository hỗ trợ.
3. Ghi sự kiện và tăng counter.
4. Tạo snapshot giám sát.
5. Liên kết sự kiện MQTT thông qua `bindMonitoring(runtime, monitoring)`.

Ví dụ counter được mô tả:

- `telemetry.received`
- `mqtt.telemetry.received`

Khi nhận sự kiện `device-message` từ MQTT runtime, hàm liên kết gọi `recordEvent()` và ghi metadata như mã phòng, mã thiết bị và loại thông điệp.

Nếu ghi nhận Monitoring lỗi, module ghi cảnh báo tương ứng thay vì để lỗi giám sát chặn handler nghiệp vụ MQTT.

### 7.5. Snapshot giám sát

`getSnapshot()` tổng hợp:

- `generatedAt`
- `components`
- `devices`
- `counters`
- `summary`

Trong `summary` có các số liệu như tổng component, số component UP/DEGRADED/DOWN, tổng thiết bị và số thiết bị online/offline.

Snapshot hiện được cung cấp ở mức service. Tài liệu nguồn chưa xác nhận API hoặc dashboard riêng cho người dùng.

### 7.6. Dữ liệu PostgreSQL

Repository PostgreSQL sử dụng:

- `monitoring_components`: trạng thái component.
- `monitoring_counters`: số lượng sự kiện theo counter.
- Bảng `devices`: nguồn đọc trạng thái thiết bị.

Heartbeat kết nối thực tế trong PostgreSQL thuộc trách nhiệm `DevicePresenceService`; `MonitoringService` không tự ghi heartbeat vào PostgreSQL repository. Không nhầm trạng thái kết nối `connectionStatus` với trạng thái vòng đời `lifecycleStatus`.

### 7.7. Chạy kiểm thử

Chạy riêng ADV-03:

```powershell
npm run test:monitoring-logging
```

Chạy toàn bộ unit test repository:

```powershell
npm test
```

Bộ test ADV-03 có 12 nhóm trường hợp:

1. Ghi log JSON có cấu trúc.
2. Che trường nhạy cảm.
3. Từ chối level/message không hợp lệ.
4. Cập nhật trạng thái component.
5. Heartbeat chuyển online/offline theo ngưỡng.
6. Đếm sự kiện và ghi log tương ứng.
7. Từ chối heartbeat timestamp không hợp lệ.
8. Từ chối trạng thái component và amount không hợp lệ.
9. Không tăng counter khi log level không hợp lệ.
10. PostgreSQL repository lưu trạng thái component.
11. PostgreSQL repository đọc thiết bị từ bảng `devices`.
12. PostgreSQL repository tăng counter bằng upsert.

Tài liệu nguồn ghi nhận kết quả local **12/12 test PASS**.

**Giới hạn của kết quả:** các test PostgreSQL repository trong bộ test này dùng pool giả lập để kiểm tra SQL và dữ liệu trả về. Kết quả đó chưa chứng minh truy vấn đã chạy trực tiếp trên PostgreSQL thật.

### 7.8. Kiểm thử tích hợp cần thực hiện

Để kiểm tra hoạt động thực tế:

1. Khởi chạy Backend và MQTT runtime.
2. Xác nhận `bindMonitoring()` được đăng ký trong quá trình khởi tạo runtime.
3. Phát sinh một sự kiện MQTT hợp lệ.
4. Kiểm tra counter tương ứng có tăng.
5. Kiểm tra log JSON có timestamp, level, service, message và metadata.
6. Đưa metadata có khóa nhạy cảm vào test và xác nhận giá trị bị che.
7. Ghi nhận heartbeat thiết bị qua luồng `DevicePresenceService`.
8. Tạo snapshot và đối chiếu trạng thái component/device với dữ liệu nguồn.
9. Kiểm tra trực tiếp PostgreSQL nếu muốn xác nhận repository thật.

Các bước trên là kế hoạch kiểm thử tích hợp. Tài liệu nguồn chưa cung cấp kết quả nghiệm thu đầu cuối với toàn bộ ESP32, MQTT runtime, PostgreSQL thật và dashboard.

### 7.9. Tiêu chí đạt

- Log có cấu trúc và đúng level.
- Metadata nhạy cảm được che theo quy tắc hiện tại.
- Dữ liệu đầu vào không hợp lệ bị từ chối.
- Component có trạng thái phù hợp.
- Thiết bị quá ngưỡng heartbeat được xem là offline.
- Counter tăng đúng sự kiện.
- Snapshot tổng hợp đúng dữ liệu repository.
- Lỗi Monitoring không làm dừng xử lý nghiệp vụ MQTT.

---

## 8. ADV-04 — Phát hiện dữ liệu môi trường bất thường

### 8.1. Mục tiêu và nguyên lý

ADV-04 phân tích dữ liệu cảm biến để phát hiện giá trị lệch đáng kể so với hành vi thông thường của từng thiết bị.

Phiên bản hiện tại dùng phương pháp thống kê robust dựa trên:

- Median.
- MAD (Median Absolute Deviation).
- Robust Z-score.

**Đây chưa phải mô hình Machine Learning được huấn luyện.** Không dùng kết quả unit test để kết luận độ chính xác của mô hình trên dữ liệu thực tế.

Các chỉ số hỗ trợ:

- `temperatureC`.
- `humidityPercent`.
- `illuminanceLux`.

### 8.2. Cấu hình baseline

Baseline được quản lý riêng cho từng cặp thiết bị và chỉ số (`deviceId`–`metric`).

Giá trị mặc định:

| Tham số | Giá trị | Ý nghĩa |
|---|---:|---|
| `minSamples` | 8 | Số mẫu lịch sử tối thiểu trước khi phân loại |
| `windowSize` | 30 | Số mẫu tối đa trong baseline |
| `threshold` | 3.5 | Ngưỡng trị tuyệt đối Robust Z-score |

Khi chưa đủ mẫu, kết quả là `WARMING_UP`. Khi đủ mẫu, service tính Median, MAD và Robust Z-score:

\[
\text{Robust Z-score} = \frac{0.6745(x-\text{Median})}{\text{MAD}}
\]

Nếu trị tuyệt đối score lớn hơn hoặc bằng threshold, mẫu được phân loại `ANOMALY`; ngược lại là `NORMAL`.

Nếu MAD bằng 0:
- Giá trị mới bằng Median: score bằng 0, coi là bình thường.
- Giá trị mới khác Median: bất thường với lý do `DEVIATION_FROM_CONSTANT_BASELINE`, score là `null`.

Mẫu bất thường không được thêm vào baseline. Baseline giữ tối đa 30 mẫu gần nhất theo cửa sổ trượt.

### 8.3. Source code cần nắm

```text
database/migrations/
  016_anomaly_detection.sql

backend/src/modules/anomaly-detection/
  anomaly-detection.errors.js
  anomaly-detection.repository.memory.js
  anomaly-detection.repository.pg.js
  anomaly-detection.service.js
  anomaly-detection.consumer.js

backend/src/server.js

tests/
  anomaly-detection.test.js
  anomaly-detection-consumer.test.js
```

| Thành phần | Công việc |
|---|---|
| `anomaly-detection.service.js` | Validate telemetry, tính thống kê robust, phân loại và quản lý baseline |
| `anomaly-detection.consumer.js` | Đọc `telemetry.stored`, kiểm tra điều kiện, gọi service và ghi delivery |
| `anomaly-detection.repository.pg.js` | Lưu/đọc baseline, kết quả, chống trùng và reset baseline |
| `anomaly-detection.repository.memory.js` | Repository trong bộ nhớ phục vụ unit test |
| `016_anomaly_detection.sql` | Tạo bảng baseline, kết quả và index |
| `server.js` | Khởi tạo consumer và job `anomaly-detection` định kỳ |

### 8.4. Cơ sở dữ liệu

Migration `016_anomaly_detection.sql` tạo:

- `anomaly_baselines`: mẫu baseline theo thiết bị và metric.
- `anomaly_detection_results`: kết quả phân tích gắn với `sensor_data` qua `data_id`.

Mỗi bản ghi telemetry có tối đa một kết quả phân tích. Baseline được lưu PostgreSQL để tồn tại qua các lần Backend khởi động lại.

Áp dụng migration bằng:

```powershell
npm run db:migrate
```

Tài liệu nguồn ghi nhận migration 016 đã được áp dụng local với kết quả `applied: 1`. Khi chạy trên môi trường khác, vẫn cần kiểm tra kết quả migration thực tế.

### 8.5. Luồng xử lý Consumer và Service

**Phần A — Consumer nhận sự kiện**

1. Consumer tìm sự kiện `telemetry.stored` chưa được delivery cho consumer `anomaly_detection`.
2. Mỗi sự kiện xử lý trong transaction riêng.
3. Đọc event và bản ghi tương ứng trong `sensor_data`.
4. Kiểm tra `eligible`, `is_latest`, `is_backfill`, `clock_skew`.
5. Kiểm tra thiết bị và phòng học có trạng thái `ACTIVE`.
6. Đối chiếu `data_id` với bản ghi mới nhất trong `telemetry_latest`.
7. Nếu không đủ điều kiện, bỏ qua và ghi nhận delivery.
8. Nếu hợp lệ, gọi `AnomalyDetectionService`.
9. Chỉ ghi delivery sau khi baseline và kết quả được lưu thành công. Nếu xử lý lỗi, transaction rollback để sự kiện có thể được thử lại.

**Phần B — Service phân tích**

1. Validate payload, `deviceId`, event ID nếu có, timestamp nếu có và chỉ số cảm biến.
2. Kiểm tra sự kiện đã xử lý chưa.
3. Đọc baseline theo từng metric.
4. Nếu chưa đủ `minSamples`, thêm mẫu và trả `WARMING_UP`.
5. Nếu đủ mẫu, tính Median, MAD và Robust Z-score.
6. Trả `NORMAL` hoặc `ANOMALY` kèm thông tin giải thích.
7. Chỉ thêm mẫu bình thường vào baseline.
8. Lưu kết quả phân tích.

Trong Consumer hiện tại, `eventId` được lấy từ `data_id` để nhận diện ổn định sự kiện.

### 8.6. Kết quả cần quan sát

Các trạng thái:

- `WARMING_UP`: chưa đủ dữ liệu.
- `NORMAL`: giá trị nằm trong ngưỡng baseline.
- `ANOMALY`: giá trị lệch khỏi baseline theo quy tắc đã cấu hình.

Kết quả tổng thể gồm `eventId`, `deviceId`, `timestamp`, `analyzedAt`, `anomalyDetected`, `findings` và `duplicate`.

Mỗi phần tử `findings` có thể chứa metric, value, status, anomaly, số mẫu baseline, median, MAD, score, threshold và reason tùy trạng thái.

### 8.7. Chạy kiểm thử

Chạy riêng ADV-04:

```powershell
npm run test:anomaly-detection
```

Chạy toàn bộ test repository:

```powershell
npm test
```

Các test ADV-04 bao gồm:

1. Trả `WARMING_UP` khi chưa đủ mẫu.
2. Phát hiện nhiệt độ lệch khỏi baseline.
3. Giá trị bình thường không bị đánh dấu bất thường.
4. Không thêm điểm bất thường vào baseline.
5. Xử lý nhiều chỉ số trong cùng telemetry.
6. Từ chối dữ liệu cảm biến không hợp lệ.
7. Không cập nhật baseline lần hai khi trùng event ID.
8. Reset baseline của một chỉ số.
9. Từ chối reset metric không hỗ trợ.
10. Consumer xử lý telemetry hợp lệ.
11. Consumer bỏ qua telemetry không eligible.
12. Consumer bỏ qua backfill hoặc clock skew.
13. Consumer bỏ qua thiết bị/phòng không hoạt động.
14. Rollback khi lưu kết quả thất bại.
15. Không xử lý lại sự kiện đã delivery.
16. Bỏ qua telemetry không còn mới nhất.

Tài liệu nguồn ghi nhận:
- ADV-04: **16/16 test PASS**.
- Toàn repository tại lần chạy được ghi nhận: **52/52 test PASS**.
- Migration 016: đã áp dụng local.

Consumer test dùng mock PostgreSQL client; do đó chưa chứng minh toàn bộ thao tác baseline/kết quả đã được kiểm thử trực tiếp trên PostgreSQL thật.

### 8.8. Kiểm thử nghiệp vụ bằng dữ liệu

Để kiểm tra logic phân loại, nên thực hiện các nhóm dữ liệu:

1. Gửi ít hơn 8 mẫu cho cùng thiết bị và metric; kiểm tra `WARMING_UP`.
2. Gửi đủ mẫu lịch sử có giá trị tương đối ổn định.
3. Gửi giá trị gần Median; kiểm tra `NORMAL`.
4. Gửi giá trị lệch lớn so với baseline; kiểm tra `ANOMALY`.
5. Kiểm tra mẫu `ANOMALY` không bị thêm vào baseline.
6. Gửi lại cùng event/data ID; kiểm tra kết quả không bị xử lý hai lần.
7. Reset baseline của một metric; xác nhận metric đó quay lại giai đoạn khởi tạo.

Để kiểm thử Consumer, cần tạo telemetry đi qua luồng ingest và phát sinh `telemetry.stored`, sau đó xác nhận consumer xử lý event. Cần đảm bảo bản ghi đủ điều kiện, là bản mới nhất, không phải backfill và không có clock skew.

### 8.9. Tiêu chí đạt

- Baseline được tách theo từng thiết bị và metric.
- Chưa đủ mẫu thì trả `WARMING_UP`.
- Đủ mẫu thì phân loại theo Robust Z-score và threshold.
- Mẫu bất thường không làm nhiễm baseline.
- Event trùng không bị phân tích lặp.
- Dữ liệu backfill, clock skew, không mới nhất hoặc thiết bị/phòng không hoạt động bị bỏ qua theo quy tắc.
- Lỗi lưu kết quả không đánh dấu delivery thành công.
- Baseline và kết quả được lưu bền vững trên PostgreSQL khi kiểm thử database thật.

### 8.10. Giới hạn cần ghi nhận

Chưa có kết quả kiểm thử PostgreSQL integration riêng và kiểm thử đầu cuối ESP32 → MQTT → ingestion → consumer. Chưa xác nhận kết quả được hiển thị trên dashboard hoặc kết nối với chức năng cảnh báo. Chưa có dữ liệu thực nghiệm để đánh giá precision, recall hay false-positive rate. Giai đoạn warming-up và trường hợp MAD bằng 0 cần được đánh giá trên dữ liệu thực tế.

---

## 9. ADV-05 — Cập nhật firmware từ xa (OTA)

### 9.1. Mục tiêu và giới hạn phạm vi

ADV-05 hiện có nền tảng Backend cho quản lý firmware, phát hành/thu hồi firmware, tạo OTA Job, gửi lệnh MQTT, nhận trạng thái OTA và cung cấp file firmware qua endpoint tải có chữ ký.

Theo tài liệu nguồn, **chưa có bằng chứng OTA hoàn chỉnh chạy trên ESP32 thật**. Không được xem các trạng thái Backend như `SUCCESS` hoặc `ROLLED_BACK` là bằng chứng thiết bị đã thực sự cài firmware hoặc rollback nếu chưa kiểm tra phần cứng.

### 9.2. Source code cần nắm

```text
database/migrations/
  017_ota_management.sql

backend/src/
  mqtt/
    runtime.js
  modules/ota/
    ota.service.js
    ota.routes.js
    ota.repository.pg.js
    ota.storage.js
    ota.download-signer.js
    ota.download.routes.js

tests/integration/
  ota.test.js
```

| Thành phần | Công việc |
|---|---|
| `ota.service.js` | Đăng ký/phát hành/thu hồi firmware, tạo job, xử lý trạng thái, retry và timeout |
| `ota.routes.js` | API quản lý firmware và OTA Job |
| `ota.repository.pg.js` | PostgreSQL firmware, job, credential/session, outbox và chuyển trạng thái |
| `ota.storage.js` | Lưu/đọc/kiểm tra file firmware |
| `ota.download-signer.js` | Ký và xác minh URL tải bằng HMAC-SHA256 |
| `ota.download.routes.js` | Xác minh token, trạng thái firmware và stream file |
| `mqtt/runtime.js` | Subscribe và xử lý topic `ota/status` |
| `017_ota_management.sql` | Tạo bảng firmware và OTA Job |

### 9.3. Cơ sở dữ liệu và trạng thái

Hai bảng nghiệp vụ chính:

- `firmware_releases`: metadata, file, hash, chữ ký và trạng thái firmware.
- `ota_jobs`: thiết bị đích, firmware, tiến độ, trạng thái, lỗi, thời hạn và thông tin session.

Outbox sử dụng bảng `ota_command_outbox` để quản lý việc gửi lệnh MQTT và retry.

Trạng thái firmware:

- `DRAFT`
- `PUBLISHED`
- `REVOKED`

Trạng thái OTA Job:

- `PENDING`
- `NOTIFIED`
- `DOWNLOADING`
- `VERIFYING`
- `INSTALLING`
- `REBOOTING`
- `SUCCESS`
- `FAILED`
- `ROLLED_BACK`
- `CANCELLED`
- `TIMEOUT`

### 9.4. Quy trình đăng ký firmware

1. Chuẩn bị file firmware `.bin` phù hợp với loại thiết bị và phần cứng mục tiêu.
2. Người có quyền `ota:firmware:write` gửi file cùng metadata qua API.
3. Backend validate phiên bản, loại thiết bị, hardware target, tên file và release notes.
4. Backend kiểm tra file không rỗng.
5. Backend tính SHA-256 và kích thước file.
6. File được lưu trong `LocalFirmwareStorage` dưới tên UUID.
7. Backend tạo bản ghi firmware ở trạng thái `DRAFT`.
8. Kiểm tra lại bản ghi trong danh sách firmware.

Loại thiết bị được hỗ trợ theo source hiện tại:
- `SENSOR_NODE`
- `CONTROL_NODE`

Không dùng một firmware cho mọi thiết bị nếu `device_type` hoặc `hardware_target` không tương thích.

### 9.5. Quy trình phát hành firmware

1. Chọn firmware đang ở `DRAFT`.
2. Gọi API publish với quyền `ota:firmware:write`.
3. Backend đọc lại file đã lưu.
4. Kiểm tra file tồn tại và kích thước khớp.
5. Tính lại SHA-256 và so với hash ban đầu.
6. Backend ký hash bằng khóa riêng Ed25519.
7. Firmware chuyển sang `PUBLISHED` và ghi `published_at`.
8. Kiểm tra firmware trong danh sách.

Firmware đã `PUBLISHED` không thể publish lại bằng API hiện tại.

**Phân biệt hai loại chữ ký:**
- Ed25519 ký SHA-256 của firmware.
- HMAC-SHA256 ký URL tải và token có thời hạn.

Hai chữ ký có mục đích khác nhau. Backend tạo chữ ký Ed25519 không đồng nghĩa ESP32 đã xác minh chữ ký đó.

### 9.6. API Backend

| Phương thức | Endpoint | Quyền | Mục đích |
|---|---|---|---|
| POST | `/api/v1/ota/firmware` | `ota:firmware:write` | Đăng ký firmware |
| GET | `/api/v1/ota/firmware` | `ota:firmware:read` | Liệt kê firmware |
| POST | `/api/v1/ota/firmware/:id/publish` | `ota:firmware:write` | Phát hành firmware |
| POST | `/api/v1/ota/firmware/:id/revoke` | `ota:firmware:write` | Thu hồi firmware |
| POST | `/api/v1/devices/:id/ota` | `ota:jobs:create` | Tạo OTA Job cho thiết bị |
| GET | `/api/v1/ota/jobs` | `ota:jobs:read` | Tra cứu OTA Job |

Endpoint tải firmware:

```text
GET /ota/download/:token/:signature
```

Các API quản lý yêu cầu xác thực và quyền tương ứng. Tài liệu nguồn không cung cấp body request hoàn chỉnh, host, token mẫu hoặc cách khởi tạo private key. Cần đọc schema, cấu hình và middleware trong source trước khi gọi API; không tự đặt khóa hoặc thông tin xác thực.

### 9.7. Tạo OTA Job

Khi yêu cầu cập nhật, Backend kiểm tra:

1. Người yêu cầu có quyền và thiết bị thuộc phạm vi quản lý.
2. Thiết bị ở trạng thái vòng đời `PROVISIONED` hoặc `ACTIVE`.
3. Thiết bị đang `ONLINE`, heartbeat còn mới và có MQTT session hợp lệ.
4. Phòng học ở trạng thái `ACTIVE`.
5. Credential thiết bị đã đồng bộ với broker (`SYNCED`).
6. Firmware ở trạng thái `PUBLISHED`.
7. `device_type` và `hardware_version` của thiết bị phù hợp với firmware.
8. Thiết bị chưa có OTA Job đang hoạt động.

Sau đó Backend tạo job, lưu session/credential version và firmware version trước cập nhật, tạo outbox và gửi lệnh qua MQTT.

### 9.8. Giao tiếp MQTT

Topic command:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/command
```

Payload command có các trường chính:

- `job_id`
- `firmware_id`
- `device_id`
- `room_id`
- `session_id`
- `version`
- `device_type`
- `hardware_target`
- `download_url`
- `file_size`
- `sha256`
- `expires_at`
- `signature`

Topic status:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/status
```

Backend nhận và kiểm tra `job_id`, `device_id`, `room_id`, `session_id`, `status`, `progress`, `error_code`, `version` và `timestamp`.

Backend kiểm tra job có thuộc đúng thiết bị, topic đúng phòng/thiết bị, session hiện tại và credential version có hợp lệ hay không. `SUCCESS` cần phiên bản báo về khớp firmware của job và progress bằng 100. `ROLLED_BACK` cần phiên bản báo về khớp firmware trước cập nhật.

### 9.9. Quy trình tải firmware và kiểm tra an toàn ở Backend

Endpoint tải firmware thực hiện:

1. Xác minh chữ ký HMAC-SHA256 của URL.
2. Kiểm tra token chưa hết hạn.
3. Kiểm tra firmware ID và storage path.
4. Kiểm tra firmware vẫn `PUBLISHED`.
5. Đối chiếu storage path với database.
6. Kiểm tra file tồn tại và kích thước khớp metadata.
7. Stream file với các header phù hợp, không cache nội dung.

Thời hạn URL tải mặc định được mô tả là 300 giây. OTA Job có timeout mặc định 900 giây theo cấu hình service hiện tại. Đây là các giá trị mặc định được ghi trong tài liệu nguồn, cần đánh giá lại khi dùng firmware và mạng thực tế.

### 9.10. Chạy kiểm thử Backend

Chạy:

```powershell
npm run test:ota
```

Script này chạy:

```powershell
node --test tests/integration/ota.test.js
```

Bộ test hiện có 12 trường hợp:

1. Đăng ký firmware hợp lệ.
2. Từ chối file rỗng.
3. Từ chối thiếu metadata.
4. Phát hành firmware và tạo chữ ký.
5. Không phát hành lại firmware đã phát hành.
6. Thu hồi firmware đã phát hành.
7. Không thu hồi firmware chưa phát hành.
8. Liệt kê firmware theo quyền.
9. Từ chối API quản lý khi không có token.
10. Xác minh URL tải có chữ ký hợp lệ.
11. Từ chối URL sai chữ ký.
12. Từ chối URL hết hạn.

**Lưu ý:** Tài liệu nguồn xác nhận có 12 test case trong source, không cung cấp kết quả chạy PASS độc lập. Cần chạy lệnh trên môi trường của nhóm và ghi nhận số test thực tế.

### 9.11. Phần firmware ESP32 cần triển khai/kiểm thử

Để OTA hoàn chỉnh trên thiết bị, cần thực hiện các công việc chưa được xác nhận trong tài liệu nguồn:

1. Xây dựng/tích hợp OTA handler cho ESP32.
2. Nhận và validate lệnh `ota/command`.
3. Kiểm tra job, firmware, device, room, session và thời hạn.
4. Tải firmware từ HTTPS URL.
5. Kiểm tra kích thước và SHA-256.
6. Xác minh chữ ký Ed25519 bằng public key tương ứng.
7. Ghi firmware vào OTA partition.
8. Chỉ chuyển boot partition sau khi kiểm tra hợp lệ.
9. Reboot và xác nhận firmware mới khởi động.
10. Gửi tiến độ và kết quả lên `ota/status`.
11. Thiết kế và kiểm thử rollback nếu firmware mới không hoạt động.
12. Xử lý mất Wi-Fi/MQTT, mất nguồn, retry và job trùng.

### 9.12. Kiểm thử đầu cuối OTA

Khi firmware OTA đã được triển khai, kiểm tra tối thiểu:

- Firmware đúng loại thiết bị và hardware target.
- Firmware sai hash.
- Chữ ký Ed25519 không hợp lệ.
- URL tải hết hạn.
- Firmware đã bị thu hồi.
- Thiết bị offline hoặc heartbeat cũ.
- Thiết bị có credential/session không hợp lệ.
- Mất Wi-Fi/MQTT trong lúc tải.
- Mất nguồn trong lúc ghi flash.
- Reboot sau cài đặt.
- Firmware mới hoạt động và Backend cập nhật `firmware_version`.
- Cố tình tạo lỗi boot để kiểm tra rollback.
- Job timeout và trạng thái thiết bị gửi đến muộn.

### 9.13. Tiêu chí đạt

**Ở mức Backend:**
- Đăng ký, phát hành và thu hồi firmware đúng quy tắc.
- Hash và chữ ký được kiểm tra.
- Chỉ firmware `PUBLISHED` mới được tạo job/tải.
- OTA Job chỉ được tạo cho thiết bị tương thích và đủ điều kiện.
- Outbox retry hoạt động theo logic.
- Status sai thiết bị/session/job bị từ chối.
- Tiến độ không giảm; `SUCCESS` yêu cầu progress 100 và version đúng.

**Ở mức thiết bị:**
- ESP32 tải đúng file, xác minh hash/chữ ký.
- Cài đặt và reboot thành công.
- Backend nhận status hợp lệ.
- Rollback hoạt động khi có lỗi.

Chỉ được kết luận OTA hoàn tất toàn hệ thống khi đã có kiểm thử trên phần cứng thật.

---

## 10. Quy trình kiểm thử tích hợp 5 chức năng

Phần này sắp xếp các bài kiểm thử theo luồng hệ thống. Đây là kế hoạch kiểm thử tích hợp; không phải khẳng định rằng toàn bộ các bước đã được thực hiện.

### 10.1. Giai đoạn 1 — Kiểm tra nền tảng

1. Kiểm tra repository và package scripts.
2. Khởi chạy PostgreSQL.
3. Khởi chạy MQTT broker.
4. Kiểm tra cấu hình Backend.
5. Áp dụng các migration cần thiết theo thứ tự migration của repository.
6. Khởi chạy Backend và kiểm tra log khởi động.
7. Xác nhận MQTT runtime kết nối broker.

### 10.2. Giai đoạn 2 — Kiểm tra telemetry và offline

1. Cho Sensor Node gửi telemetry bình thường.
2. Xác nhận Backend lưu telemetry.
3. Ngắt mạng và tạo một số bản ghi.
4. Xác nhận các bản ghi được giữ trong LittleFS.
5. Khởi động lại thiết bị khi vẫn còn dữ liệu chờ.
6. Khôi phục mạng.
7. Xác nhận thiết bị gửi bù dữ liệu.
8. Xác nhận Backend chống trùng và chỉ ACK `STORED` sau khi commit.
9. Xác nhận dữ liệu backfill không ghi đè dữ liệu mới nhất.

### 10.3. Giai đoạn 3 — Kiểm tra Monitoring và Logging

1. Phát sinh telemetry và sự kiện MQTT.
2. Kiểm tra counter tương ứng.
3. Kiểm tra log JSON.
4. Kiểm tra dữ liệu nhạy cảm bị che.
5. Kiểm tra heartbeat và trạng thái online/offline.
6. Tạo snapshot và đối chiếu dữ liệu component/device.

### 10.4. Giai đoạn 4 — Kiểm tra phát hiện bất thường

1. Gửi telemetry hợp lệ từ thiết bị đang ACTIVE.
2. Đảm bảo dữ liệu là mới nhất, không phải backfill và không clock skew.
3. Gửi đủ mẫu để baseline đạt `minSamples`.
4. Gửi giá trị bình thường và xác nhận `NORMAL`.
5. Gửi giá trị lệch và xác nhận `ANOMALY`.
6. Kiểm tra mẫu bất thường không được đưa vào baseline.
7. Gửi lại cùng event/data ID và xác nhận không xử lý trùng.
8. Kiểm tra baseline và kết quả được lưu trong PostgreSQL.

### 10.5. Giai đoạn 5 — Kiểm tra Device Shadow

1. Đăng ký Control Node và xác nhận Shadow được tạo.
2. Truy vấn Desired/Reported State ban đầu.
3. Gửi lệnh bật đèn hoặc quạt.
4. Xác nhận Desired State và version thay đổi.
5. Xác nhận Reported State chưa thay đổi trước phản hồi.
6. Cho thiết bị thực thi và gửi ACK/Reported State.
7. Xác nhận trạng thái command và Shadow được cập nhật.
8. Gửi ACK sai session/version hoặc ACK lặp để kiểm tra từ chối/chống ghi đè.

### 10.6. Giai đoạn 6 — Kiểm tra OTA

Chỉ thực hiện phần thiết bị khi đã có firmware OTA tương ứng và đã thống nhất hợp đồng MQTT.

1. Đăng ký firmware tương thích.
2. Phát hành firmware.
3. Tạo OTA Job cho thiết bị đủ điều kiện.
4. Kiểm tra lệnh OTA được gửi.
5. Thiết bị tải firmware và báo tiến độ.
6. Thiết bị xác minh hash/chữ ký và cài đặt.
7. Thiết bị reboot, xác nhận phiên bản mới.
8. Backend nhận `SUCCESS` và cập nhật `firmware_version`.
9. Thực hiện kịch bản lỗi để kiểm tra `FAILED`, `TIMEOUT` hoặc `ROLLED_BACK`.

### 10.7. Ghi nhận kết quả

Với mỗi bài kiểm thử, ghi tối thiểu:

| Trường | Nội dung cần ghi |
|---|---|
| Mã test | Ví dụ `ADV02-IT-01` |
| Mục tiêu | Nghiệp vụ cần xác nhận |
| Môi trường | Local, Docker, MQTT test broker, ESP32 thật... |
| Dữ liệu đầu vào | Payload, thiết bị, trạng thái ban đầu |
| Các bước | Trình tự thao tác thực tế |
| Kết quả mong đợi | Điều kiện phải đạt |
| Kết quả thực tế | Phản hồi API, log, database, MQTT hoặc thiết bị |
| Trạng thái | PASS / FAIL / BLOCKED / NOT TESTED |
| Bằng chứng | Ảnh terminal, log đã che secret, truy vấn kết quả hoặc video kiểm thử |
| Ghi chú | Lỗi, giới hạn và việc cần xử lý |

Không ghi PASS nếu chỉ mới đọc source hoặc nhìn thấy test case. Nếu chưa có phần cứng hoặc dependency, ghi `BLOCKED` hoặc `NOT TESTED` và nêu rõ lý do.

---

## 11. Bảng tổng hợp lệnh chạy và kiểm thử

Chạy các lệnh từ thư mục gốc repository, trừ khi ghi chú khác.

| Chức năng | Lệnh | Mục đích |
|---|---|---|
| ADV-01 | `npm run test:device-shadow` | Unit test Device Shadow |
| ADV-01 | `node --test tests/integration/commands.test.js` | Kiểm thử tích hợp luồng Commands/Shadow |
| ADV-02 | `docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test` | Khởi chạy dịch vụ test |
| ADV-02 | `npm run mqtt:bootstrap:test` | Bootstrap MQTT test |
| ADV-02 | `node --test tests/integration/telemetry.test.js` | Integration test telemetry |
| ADV-03 | `npm run test:monitoring-logging` | Test Monitoring và Logging |
| ADV-03 | `npm test` | Chạy toàn bộ test repository |
| ADV-04 | `npm run db:migrate` | Áp dụng migration |
| ADV-04 | `npm run test:anomaly-detection` | Test phát hiện bất thường |
| ADV-04 | `npm test` | Chạy toàn bộ test repository |
| ADV-05 | `npm run test:ota` | Integration test Backend OTA |

### 11.1. Kết quả được ghi nhận trong các tài liệu đầu vào

| Chức năng | Kết quả được tài liệu nguồn ghi nhận | Phạm vi kết quả |
|---|---:|---|
| ADV-01 | 11/11 PASS | Unit test Device Shadow |
| ADV-02 | 6/6 PASS | Integration test Backend qua MQTT test broker và PostgreSQL test |
| ADV-03 | 12/12 PASS | Unit test; test repository PostgreSQL dùng pool giả lập |
| ADV-04 | 16/16 PASS; toàn repository 52/52 PASS | Unit test và consumer mock test; chưa phải PostgreSQL integration thực |
| ADV-05 | Có 12 test case | Chưa có kết quả PASS được xác nhận trong tài liệu nguồn |

Các kết quả trên là kết quả được ghi trong tài liệu đầu vào, không phải kết quả vừa chạy lại trong quá trình tạo hướng dẫn này. Khi kiểm thử ở máy hoặc nhánh hiện tại, phải chạy lại và ghi nhận output thực tế.

---

## 12. Xử lý lỗi và lưu ý vận hành

### 12.1. Lỗi database hoặc migration

- Kiểm tra PostgreSQL có đang chạy không.
- Kiểm tra host, port, database và credential trong cấu hình local.
- Xác nhận đang kết nối đúng database test hay database phát triển.
- Kiểm tra migration đã được áp dụng chưa.
- Không chạy test phá hủy dữ liệu trên database thật.

### 12.2. Lỗi MQTT

- Kiểm tra broker đang chạy và Backend đã kết nối.
- Kiểm tra topic đúng cấu trúc và mã phòng/thiết bị.
- Kiểm tra payload có định danh khớp topic.
- Kiểm tra credential, role và session thiết bị.
- Phân biệt MQTT QoS acknowledgement với ACK nghiệp vụ của ứng dụng.

### 12.3. Lỗi đồng bộ Device Shadow

- Không tự cập nhật Reported State khi chỉ mới publish command.
- Kiểm tra `command_id`, `session_id`, `shadow_version`.
- Kiểm tra ACK có khớp trạng thái yêu cầu không.
- Kiểm tra timestamp/version để tránh dữ liệu cũ ghi đè trạng thái mới.

### 12.4. Lỗi hàng đợi offline

- Không xóa bản ghi chỉ vì publish MQTT thành công.
- Chỉ xóa khi ACK ứng dụng `STORED` đúng mã định danh.
- Kiểm tra LittleFS đã mount thành công.
- Kiểm tra hàng đợi đầy, file tạm/backup và khả năng phục hồi sau reboot.
- Kiểm tra firmware và Backend đang dùng cùng định dạng ACK.

### 12.5. Lỗi Monitoring

- Kiểm tra log level và message có hợp lệ.
- Không đưa secret vào message tự do.
- Phân biệt connection status với lifecycle status.
- Kiểm tra heartbeat theo ngưỡng thời gian.
- Không kết luận repository PostgreSQL hoạt động thực tế chỉ từ test dùng pool giả lập.

### 12.6. Lỗi phát hiện bất thường

- Kiểm tra dữ liệu có phải bản ghi mới nhất không.
- Kiểm tra `eligible`, `is_backfill`, `clock_skew`.
- Kiểm tra thiết bị và phòng học có ACTIVE không.
- Kiểm tra baseline đã đủ `minSamples` chưa.
- Kiểm tra metric, đơn vị và kiểu dữ liệu.
- Không đánh giá độ chính xác của thuật toán chỉ bằng unit test.

### 12.7. Lỗi OTA

- Kiểm tra firmware đúng `device_type` và `hardware_target`.
- Kiểm tra file, kích thước và SHA-256.
- Kiểm tra firmware đã `PUBLISHED`.
- Kiểm tra thiết bị online, heartbeat, session và credential.
- Phân biệt chữ ký Ed25519 của firmware hash với HMAC của URL tải.
- Không coi MQTT publish thành công là cài đặt thành công.
- Không coi Backend `TIMEOUT` là thiết bị đã rollback.
- Không coi trạng thái `ROLLED_BACK` trong Backend là bằng chứng rollback vật lý nếu chưa kiểm tra thiết bị.

---

## 13. Checklist nghiệm thu

### 13.1. ADV-01 — Digital Twin / Device Shadow

- [ ] Tạo được Shadow cho Control Node.
- [ ] Desired State và Reported State được lưu riêng.
- [ ] Tạo command làm tăng version Desired State.
- [ ] MQTT command đúng topic/payload.
- [ ] ACK/Reported State hợp lệ cập nhật trạng thái thực tế.
- [ ] Phát hiện đúng `in_sync` và `differences`.
- [ ] Kiểm tra ACK sai session/version, ACK lặp và timeout.
- [ ] Kiểm thử với ESP32/Mosquitto thật nếu nghiệm thu đầu cuối.

### 13.2. ADV-02 — Offline Data Buffering & Synchronization

- [ ] Telemetry được lưu vào LittleFS trước khi gửi.
- [ ] Mất Wi-Fi/MQTT không làm mất bản ghi đang chờ.
- [ ] Hàng đợi phục hồi sau reboot.
- [ ] Kết nối lại gửi được dữ liệu bù.
- [ ] Chỉ ACK `STORED` đúng ID mới xóa bản ghi.
- [ ] Backend chống trùng theo thiết bị và mã bản tin.
- [ ] Backfill không ghi đè dữ liệu mới nhất.
- [ ] Đã thống nhất payload/ACK giữa firmware và Backend.
- [ ] Đã kiểm thử trên ESP32 thật.

### 13.3. ADV-03 — Monitoring và Logging

- [ ] Log JSON có đủ trường chính.
- [ ] Dữ liệu nhạy cảm được che.
- [ ] Dữ liệu log sai bị từ chối.
- [ ] Trạng thái component được cập nhật.
- [ ] Heartbeat xác định online/offline đúng ngưỡng.
- [ ] Counter tăng đúng sự kiện.
- [ ] Snapshot tổng hợp đúng.
- [ ] Đã xác nhận liên kết MQTT runtime.
- [ ] Đã kiểm tra PostgreSQL thật nếu nghiệm thu repository.
- [ ] Đã xác nhận giao diện nếu yêu cầu dashboard.

### 13.4. ADV-04 — Phát hiện dữ liệu môi trường bất thường

- [ ] Migration tạo được hai bảng ADV-04.
- [ ] Baseline tách theo thiết bị và metric.
- [ ] Chưa đủ mẫu trả `WARMING_UP`.
- [ ] Mẫu bình thường trả `NORMAL`.
- [ ] Mẫu lệch trả `ANOMALY`.
- [ ] Mẫu bất thường không được thêm vào baseline.
- [ ] Event trùng không bị xử lý lặp.
- [ ] Dữ liệu backfill/clock skew/không mới nhất bị bỏ qua.
- [ ] Lỗi lưu kết quả không đánh dấu delivery.
- [ ] Đã kiểm thử PostgreSQL và luồng MQTT đầu cuối nếu nghiệm thu tích hợp.
- [ ] Có dữ liệu thực nghiệm nếu cần đánh giá tỷ lệ báo động giả.

### 13.5. ADV-05 — OTA

- [ ] Đăng ký firmware và lưu được metadata/hash.
- [ ] Phát hành firmware sau khi kiểm tra lại file.
- [ ] Thu hồi firmware đúng điều kiện.
- [ ] Tạo OTA Job chỉ cho thiết bị tương thích và đủ điều kiện.
- [ ] Outbox gửi/retry lệnh MQTT đúng logic.
- [ ] Backend kiểm tra status theo job/device/session/credential.
- [ ] URL tải kiểm tra chữ ký và thời hạn.
- [ ] Firmware ESP32 tải file và kiểm tra SHA-256.
- [ ] ESP32 xác minh chữ ký Ed25519.
- [ ] ESP32 cài đặt, reboot và xác nhận phiên bản.
- [ ] Đã thử lỗi tải/cài đặt/mất nguồn.
- [ ] Đã kiểm thử rollback trên phần cứng thật.

### 13.6. Quy tắc kết luận

- Nếu chỉ có mã nguồn: ghi **Đã triển khai module**.
- Nếu test tự động chạy thành công: ghi **Đã kiểm thử tự động**, kèm số test và loại test.
- Nếu test dùng mock/in-memory: ghi rõ phạm vi mock/in-memory.
- Nếu đã chạy với database/MQTT thật: ghi rõ môi trường và kết quả.
- Nếu đã thử trên ESP32 thật: ghi rõ board, firmware, tình huống và bằng chứng.
- Nếu chưa thực hiện: ghi **Chưa kiểm thử** hoặc **Chưa xác nhận**, không ghi PASS.

---

## 14. Kết luận

Năm chức năng nâng cao bổ sung các năng lực quan trọng cho hệ thống phòng học thông minh: quản lý trạng thái thiết bị, duy trì dữ liệu khi mất mạng, giám sát và ghi log, phát hiện dữ liệu môi trường bất thường và cập nhật firmware từ xa.

Trình tự thực hiện hợp lý là chuẩn bị môi trường và database trước, kiểm thử từng module độc lập, sau đó kiểm tra luồng MQTT/PostgreSQL và cuối cùng mới nghiệm thu trên phần cứng. Với các chức năng có firmware, kết quả test Backend không thay thế việc biên dịch, nạp và kiểm tra ESP32 thật.

Khi báo cáo kết quả, cần phân biệt rõ **đã triển khai**, **đã kiểm thử tự động**, **đã kiểm thử tích hợp** và **đã nghiệm thu phần cứng**. Đây là cơ sở để đánh giá đúng mức độ hoàn thiện của từng ADV và tránh kết luận vượt quá bằng chứng hiện có.
