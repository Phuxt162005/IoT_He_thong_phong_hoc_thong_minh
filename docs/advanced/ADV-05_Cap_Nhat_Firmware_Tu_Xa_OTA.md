# ADV-05 — Cập nhật firmware từ xa (OTA)

**Mã chức năng:** ADV-05  
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Loại tài liệu:** Tài liệu kỹ thuật độc lập  
**Phạm vi:** Backend OTA, PostgreSQL, MQTT, firmware storage, API và kiểm thử tự động  
**Phiên bản:** 1.0  
**Ngày cập nhật trạng thái:** 09/11/2026

---

## 1. Tổng quan

### 1.1. Mục tiêu

ADV-05 xây dựng nền tảng Backend hỗ trợ quản lý và điều phối cập nhật firmware từ xa cho các thiết bị IoT trong hệ thống phòng học thông minh. Backend tiếp nhận và quản lý bản firmware, kiểm tra tính toàn vẹn, phát hành firmware, tạo yêu cầu cập nhật cho thiết bị, gửi lệnh qua MQTT, cung cấp file firmware qua HTTPS và tiếp nhận trạng thái thực hiện từ thiết bị.

### 1.2. Đối tượng áp dụng

Theo mã nguồn và migration hiện tại, chức năng hỗ trợ hai loại thiết bị:

- `SENSOR_NODE`: nút cảm biến.
- `CONTROL_NODE`: nút điều khiển.

Mỗi bản firmware được gắn với `device_type` và `hardware_target`. Khi tạo OTA Job, Backend đối chiếu loại thiết bị và phiên bản phần cứng của thiết bị đích với thông tin firmware.

### 1.3. Phạm vi đã triển khai

- Tiếp nhận file firmware và metadata.
- Tính SHA-256 và lưu kích thước file.
- Lưu file trong vùng lưu trữ firmware cục bộ.
- Quản lý firmware với trạng thái `DRAFT`, `PUBLISHED`, `REVOKED`.
- Ký giá trị SHA-256 bằng Ed25519 khi phát hành firmware.
- Tạo URL tải firmware có chữ ký HMAC-SHA256 và thời hạn.
- Cung cấp endpoint tải file, chỉ cho phép tải firmware đang `PUBLISHED`.
- Tạo OTA Job cho thiết bị đáp ứng điều kiện.
- Gửi lệnh OTA qua MQTT bằng cơ chế outbox.
- Nhận trạng thái OTA qua topic `ota/status`.
- Kiểm tra thiết bị, phòng, job, session MQTT và credential trước khi chấp nhận trạng thái.
- Theo dõi tiến độ, trạng thái kết thúc, lỗi và timeout.
- Cập nhật `firmware_version` khi nhận kết quả `SUCCESS` hợp lệ.
- Ghi audit và phát sự kiện nội bộ khi firmware hoặc OTA Job thay đổi.

### 1.4. Giới hạn phạm vi

Tài liệu mô tả những gì được xác nhận trong mã nguồn Backend và kết quả kiểm thử hiện có. Không xem các chức năng sau là đã nghiệm thu trên thiết bị thật:

- ESP32 tải firmware qua HTTPS.
- ESP32 xác minh chữ ký Ed25519 và SHA-256.
- Ghi firmware vào OTA partition.
- Chuyển boot partition và reboot.
- Xác nhận firmware mới hoạt động sau reboot.
- Bootloader thực hiện rollback khi firmware mới không khởi động được.

README của repository nêu hệ thống chưa nghiệm thu ESP32/relay thật và frontend. Vì vậy, Backend hoàn thành không đồng nghĩa toàn bộ quy trình OTA phần cứng đã hoàn thành.

---

## 2. Kiến trúc hệ thống

### 2.1. Thành phần

1. **Backend OTA Service:** xử lý nghiệp vụ quản lý firmware, tạo OTA Job, kiểm tra điều kiện thiết bị, gửi lệnh và tiếp nhận trạng thái.
2. **PostgreSQL:** lưu metadata firmware, OTA Job, outbox và dữ liệu audit.
3. **MQTT Broker:** truyền lệnh OTA từ Backend đến thiết bị và chuyển trạng thái từ thiết bị về Backend.
4. **Firmware Storage:** lưu file firmware để cung cấp cho thiết bị tải xuống.
5. **IoT Device:** Sensor Node hoặc Control Node. Mã nguồn Backend định nghĩa hợp đồng giao tiếp; việc thực thi OTA trên ESP32 thật chưa được nghiệm thu.

### 2.2. Sơ đồ kiến trúc logic

```text
                 Admin / Operator
                        |
                        | HTTP API
                        v
              +---------------------+
              |    Backend OTA      |
              | Firmware / OTA Job  |
              | Download API        |
              +---------------------+
                  |       |       |
                  v       v       v
              PostgreSQL Storage MQTT Broker
                                  |
                                  | ota/command
                                  v
                             IoT Device
                                  |
                                  | ota/status
                                  v
                             MQTT Broker
                                  |
                                  v
                           Backend OTA Service
```

Sơ đồ mô tả phần tích hợp Backend. Thiết bị thực tế cần firmware OTA tương thích để tải, xác minh và cài đặt firmware; phần này chưa được xác nhận trên phần cứng thật.

### 2.3. Luồng dữ liệu tổng quát

1. Người quản trị đăng ký file firmware và metadata.
2. Backend tính SHA-256, lưu file và tạo firmware `DRAFT`.
3. Người có quyền phát hành firmware.
4. Backend đọc lại file, kiểm tra kích thước và SHA-256, sau đó ký hash bằng Ed25519.
5. Người có quyền yêu cầu cập nhật cho thiết bị.
6. Backend kiểm tra trạng thái thiết bị, phòng, credential, session và khả năng tương thích phần cứng.
7. Backend tạo OTA Job và bản ghi outbox.
8. Outbox gửi lệnh OTA qua MQTT.
9. Thiết bị nhận lệnh và có thể tải file từ endpoint HTTPS.
10. Backend tiếp nhận trạng thái OTA qua MQTT và cập nhật OTA Job.

---

## 3. Cấu trúc mã nguồn liên quan

```text
source code IoT/
├── package.json
├── database/
│   └── migrations/
│       └── 017_ota_management.sql
├── backend/
│   └── src/
│       ├── mqtt/
│       │   ├── bootstrap.js
│       │   ├── bootstrap-cli.js
│       │   └── runtime.js
│       └── modules/
│           └── ota/
│               ├── ota.service.js
│               ├── ota.routes.js
│               ├── ota.repository.pg.js
│               ├── ota.storage.js
│               ├── ota.download-signer.js
│               └── ota.download.routes.js
└── tests/
    ├── helpers/iot.js
    └── integration/ota.test.js
```

| Thành phần | Trách nhiệm |
|---|---|
| `017_ota_management.sql` | Tạo bảng firmware, OTA Job, index và ràng buộc dữ liệu. |
| `ota.service.js` | Xử lý đăng ký, phát hành, thu hồi firmware; tạo job; kiểm tra thiết bị; xử lý trạng thái, retry và timeout. |
| `ota.routes.js` | Khai báo API quản lý firmware và OTA Job, kiểm tra quyền và validate dữ liệu. |
| `ota.repository.pg.js` | Truy vấn PostgreSQL cho firmware, OTA Job và dữ liệu liên quan. |
| `ota.storage.js` | Lưu, đọc, kiểm tra và xóa file firmware. |
| `ota.download-signer.js` | Tạo và xác minh URL tải bằng HMAC-SHA256. |
| `ota.download.routes.js` | Xác minh URL tải, kiểm tra firmware và stream file. |
| `mqtt/bootstrap.js` | Khởi tạo role và ACL cho Backend, Sensor Node và Control Node. |
| `mqtt/runtime.js` | Kết nối MQTT, subscribe topic và chuyển thông điệp đến handler. |
| `tests/integration/ota.test.js` | Kiểm thử nghiệp vụ OTA qua integration fixture. |
| `tests/helpers/iot.js` | Tạo database, MQTT broker, thiết bị và Backend fixture. |
| `package.json` | Khai báo lệnh kiểm thử OTA và integration. |

---

## 4. Thiết kế cơ sở dữ liệu

Migration `database/migrations/017_ota_management.sql` tạo hai bảng nghiệp vụ chính: `firmware_releases` và `ota_jobs`. Hệ thống còn sử dụng `ota_command_outbox` để gửi lệnh có khả năng retry.

### 4.1. Bảng `firmware_releases`

| Trường | Ý nghĩa |
|---|---|
| `firmware_id` | UUID định danh firmware. |
| `version` | Phiên bản firmware. |
| `device_type` | `SENSOR_NODE` hoặc `CONTROL_NODE`. |
| `hardware_target` | Mục tiêu phần cứng tương thích. |
| `file_name` | Tên file do người dùng cung cấp. |
| `storage_path` | Đường dẫn file trong vùng lưu trữ. |
| `file_size` | Kích thước file, phải lớn hơn 0. |
| `sha256` | SHA-256 của nội dung file. |
| `release_notes` | Ghi chú phát hành. |
| `status` | `DRAFT`, `PUBLISHED` hoặc `REVOKED`. |
| `created_by` | Người đăng ký firmware. |
| `created_at` | Thời điểm đăng ký. |
| `published_at` | Thời điểm phát hành; NULL khi `DRAFT`. |

Ràng buộc chính:

- `device_type` chỉ nhận `SENSOR_NODE` hoặc `CONTROL_NODE`.
- `file_size` phải lớn hơn 0.
- `sha256` phải có 64 ký tự hexadecimal.
- Tổ hợp `device_type`, `hardware_target`, `version` là duy nhất.
- Firmware `DRAFT` phải có `published_at` là NULL.
- Firmware `PUBLISHED` hoặc `REVOKED` phải có `published_at`.

### 4.2. Bảng `ota_jobs`

| Trường | Ý nghĩa |
|---|---|
| `job_id` | UUID định danh OTA Job. |
| `firmware_id` | Firmware được yêu cầu cài đặt. |
| `device_id` | Thiết bị đích. |
| `room_id` | Phòng học của thiết bị tại thời điểm tạo job. |
| `session_id` | Session MQTT tại thời điểm tạo job. |
| `credential_version` | Phiên bản credential được sử dụng khi tạo job. |
| `previous_firmware_version` | Phiên bản firmware trước cập nhật. |
| `status` | Trạng thái tiến trình OTA. |
| `progress` | Tiến độ từ 0 đến 100. |
| `error_code` | Mã lỗi nếu có. |
| `requested_by` | Người yêu cầu cập nhật. |
| `created_at` | Thời điểm tạo job. |
| `started_at` | Thời điểm bắt đầu xử lý. |
| `last_status_at` | Thời điểm nhận trạng thái gần nhất. |
| `finished_at` | Thời điểm kết thúc. |
| `timeout_at` | Thời điểm hết hạn job. |

Các trạng thái được migration khai báo:

`PENDING`, `NOTIFIED`, `DOWNLOADING`, `VERIFYING`, `INSTALLING`, `REBOOTING`, `SUCCESS`, `FAILED`, `ROLLED_BACK`, `CANCELLED`, `TIMEOUT`.

Ràng buộc chính:

- `progress` nằm trong khoảng 0–100.
- Mỗi thiết bị chỉ có tối đa một OTA Job đang hoạt động.
- Job ở trạng thái kết thúc phải có `finished_at`.
- Job chưa kết thúc không được có `finished_at`.

### 4.3. Bảng `ota_command_outbox`

Outbox lưu các lệnh OTA cần gửi qua MQTT, tách transaction nghiệp vụ khỏi thao tác publish mạng và hỗ trợ retry khi broker hoặc thiết bị chưa sẵn sàng.

Outbox theo dõi trạng thái xử lý, số lần thử, thời điểm thử tiếp theo, thông tin khóa xử lý và lỗi gần nhất. Các trạng thái xử lý gồm `PENDING`, `PROCESSING`, `SENT` và `CANCELLED`.

`ota_jobs` lưu trạng thái nghiệp vụ của lần cập nhật; outbox theo dõi việc gửi lệnh.

---

## 5. Quy trình nghiệp vụ OTA

### 5.1. Đăng ký firmware

1. Người có quyền gửi file và metadata qua API.
2. Backend kiểm tra phiên bản, loại thiết bị, mục tiêu phần cứng, tên file và ghi chú phát hành.
3. Backend từ chối file không hợp lệ hoặc file rỗng.
4. Backend tính SHA-256 và kích thước file.
5. File được lưu trong `LocalFirmwareStorage`.
6. Backend tạo bản ghi firmware `DRAFT`.
7. Backend ghi audit.
8. Nếu transaction tạo metadata thất bại, Backend cố gắng xóa file vừa lưu để tránh file mồ côi.

### 5.2. Phát hành firmware

1. Người có quyền chọn firmware `DRAFT`.
2. Backend khóa bản ghi firmware trong transaction.
3. Backend đọc lại file từ vùng lưu trữ.
4. Backend kiểm tra file tồn tại và kích thước khớp `file_size`.
5. Backend tính lại SHA-256 và đối chiếu hash đã lưu.
6. Backend ký giá trị hash bằng khóa riêng Ed25519.
7. Backend chuyển firmware sang `PUBLISHED`, lưu chữ ký và thời điểm phát hành.
8. Backend ghi audit và phát sự kiện `ota.firmware_published`.

Firmware `PUBLISHED` không thể phát hành lại bằng API publish hiện tại.

### 5.3. Tạo OTA Job

Khi người dùng yêu cầu cập nhật firmware, Backend kiểm tra:

- Người dùng có quyền `ota:jobs:create` và phạm vi truy cập thiết bị.
- Thiết bị ở trạng thái `PROVISIONED` hoặc `ACTIVE`.
- Thiết bị `ONLINE`, có heartbeat còn hiệu lực và session MQTT hợp lệ.
- Phòng học `ACTIVE`.
- Credential thiết bị đã đồng bộ với broker (`SYNCED`).
- Firmware đang `PUBLISHED`.
- `device_type` của firmware khớp loại thiết bị.
- `hardware_target` của firmware khớp `hardware_version` của thiết bị.
- Thiết bị không có OTA Job đang hoạt động.

Nếu hợp lệ, Backend tạo OTA Job, lưu session và credential version, ghi nhận phiên bản firmware trước cập nhật, chuyển job sang `NOTIFIED`, ghi audit, phát sự kiện `ota.job_created` và tạo outbox.

### 5.4. Gửi lệnh OTA qua MQTT

Lệnh OTA được gửi đến topic:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/command
```

Payload minh họa:

```json
{
  "job_id": "UUID",
  "firmware_id": "UUID",
  "device_id": "SENSOR_01",
  "room_id": "ROOM_302",
  "session_id": "current-session",
  "version": "1.0.1",
  "device_type": "SENSOR_NODE",
  "hardware_target": "ESP32",
  "download_url": "https://firmware.example/ota/download/...",
  "file_size": 123456,
  "sha256": "64-character-hex-string",
  "expires_at": 1793181895000,
  "signature": "base64-ed25519-signature"
}
```

Đây là cấu trúc minh họa các trường dữ liệu; giá trị thực tế được tạo theo firmware, thiết bị và cấu hình của mỗi yêu cầu.

Trước khi publish, Backend kiểm tra firmware còn được phát hành, loại thiết bị và phần cứng tương thích, trạng thái phòng, kết nối, heartbeat, session và credential version.

Nếu broker hoặc thiết bị tạm thời chưa sẵn sàng, outbox có thể đưa lệnh về `PENDING` để thử lại. Logic hiện tại sử dụng khoảng chờ tăng dần, tối đa 30 giây. Lỗi không thể retry có thể khiến job kết thúc ở `FAILED` và outbox tương ứng bị hủy.

MQTT publish thành công chỉ xác nhận Backend đã gửi lệnh tới broker; không chứng minh thiết bị đã tải hoặc cài đặt firmware.

### 5.5. Tải firmware qua HTTPS

Endpoint tải:

```text
GET /ota/download/:token/:signature
```

URL sử dụng token và chữ ký HMAC-SHA256, có thời hạn. Khi nhận yêu cầu tải, Backend:

1. Xác minh chữ ký HMAC-SHA256 bằng phép so sánh an toàn.
2. Kiểm tra token hợp lệ và chưa hết hạn.
3. Truy vấn firmware với điều kiện `status = 'PUBLISHED'`.
4. Đối chiếu `storage_path` trong token với database.
5. Kiểm tra file tồn tại, là file hợp lệ, kích thước lớn hơn 0 và khớp `file_size`.
6. Stream file với `Content-Type: application/octet-stream`, `Content-Length`, `Cache-Control: no-store` và `X-Content-Type-Options: nosniff`.

### 5.6. Nhận trạng thái OTA

Backend nhận trạng thái từ topic:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/status
```

Schema trạng thái gồm:

- `job_id`
- `device_id`
- `room_id`
- `session_id`
- `status`
- `progress` (tùy chọn)
- `error_code` (tùy chọn)
- `version` (tùy chọn)
- `timestamp`

Các trạng thái thiết bị có thể gửi theo schema hiện tại:

`DOWNLOADING`, `VERIFYING`, `INSTALLING`, `REBOOTING`, `SUCCESS`, `FAILED`, `ROLLED_BACK`.

Backend kiểm tra payload, topic, thiết bị, phòng, job, session và credential. Trạng thái từ phiên không hợp lệ hoặc thiết bị không còn đủ điều kiện sẽ bị từ chối.

Khi nhận `SUCCESS`, Backend yêu cầu phiên bản báo về khớp phiên bản firmware của job và tiến độ đạt 100, sau đó cập nhật `devices.firmware_version`.

Khi nhận `ROLLED_BACK`, Backend yêu cầu phiên bản báo về khớp `previous_firmware_version` đã lưu trong job rồi cập nhật lại phiên bản firmware của thiết bị.

Các lần cập nhật trạng thái được ghi audit và phát sự kiện `ota.job_updated`.

### 5.7. Timeout

Constructor của `OtaService` đặt thời hạn mặc định cho OTA Job là 900 giây. Backend có logic phát hiện job quá hạn, chuyển sang `TIMEOUT`, đặt `error_code = OTA_TIMEOUT`, xử lý outbox chưa gửi và phát sự kiện cập nhật job.

`TIMEOUT` chỉ thể hiện Backend không nhận được tiến trình hoặc kết quả hợp lệ trước thời hạn; không phải bằng chứng thiết bị đã rollback.

### 5.8. Thu hồi firmware

1. Người có quyền chọn firmware `PUBLISHED`.
2. Backend khóa bản ghi firmware.
3. Backend kiểm tra firmware không còn OTA Job đang hoạt động.
4. Nếu firmware đang được sử dụng bởi job hoạt động, Backend từ chối thao tác.
5. Nếu hợp lệ, firmware chuyển `REVOKED`.
6. Backend ghi audit và phát sự kiện `ota.firmware_revoked`.

Firmware `DRAFT` không thể thu hồi bằng API hiện tại.

---

## 6. Giao tiếp MQTT và phân quyền

### 6.1. Topic OTA

| Hướng | Topic | Mục đích |
|---|---|---|
| Backend → thiết bị | `smartclassroom/room/{room_code}/device/{device_code}/ota/command` | Gửi lệnh cập nhật firmware. |
| Thiết bị → Backend | `smartclassroom/room/{room_code}/device/{device_code}/ota/status` | Gửi tiến độ và kết quả OTA. |
| Thiết bị → Backend | `smartclassroom/room/{room_code}/device/{device_code}/ota/ack` | Xác nhận xử lý thông điệp OTA theo ACL và hợp đồng thiết bị. |

### 6.2. MQTT Dynamic Security

Repository sử dụng Mosquitto Dynamic Security. ACL mặc định ở chế độ từ chối; từng role chỉ được truy cập topic được cấp rõ ràng.

| Role | Quyền liên quan OTA |
|---|---|
| `sensor_role` | Publish `ota/status`; subscribe/nhận `ota/command` và `ota/ack` theo topic của chính thiết bị. |
| `control_role` | Publish `ota/status`; subscribe/nhận `ota/command` và `ota/ack` theo topic của chính thiết bị. |
| `backend_role` | Publish, nhận và subscribe các topic thuộc `smartclassroom/#` để điều phối giao tiếp. |

ACL của thiết bị sử dụng mẫu topic gắn với mã định danh client (`%u`), giới hạn quyền theo đúng thiết bị.

### 6.3. Khởi tạo broker kiểm thử

Trước khi chạy integration test cần bootstrap broker kiểm thử:

```powershell
npm run mqtt:bootstrap:test
```

Lệnh sử dụng cấu hình `TEST_*` trong `.env.test` để tạo hoặc cập nhật role và ACL trên broker test. Nếu bỏ qua bước bootstrap hoặc broker giữ ACL cũ, thao tác Subscribe của thiết bị có thể bị từ chối với lỗi MQTT `Not authorized`.

---

## 7. API Backend

Các API quản lý OTA được khai báo trong `backend/src/modules/ota/ota.routes.js`. API quản lý yêu cầu xác thực và quyền tương ứng.

| Method | Endpoint | Quyền | Chức năng |
|---|---|---|---|
| `POST` | `/api/v1/ota/firmware` | `ota:firmware:write` | Đăng ký file firmware và metadata; tạo firmware `DRAFT`. |
| `GET` | `/api/v1/ota/firmware` | `ota:firmware:read` | Danh sách firmware; hỗ trợ bộ lọc và phân trang. |
| `POST` | `/api/v1/ota/firmware/:id/publish` | `ota:firmware:write` | Kiểm tra hash, ký Ed25519 và phát hành firmware. |
| `POST` | `/api/v1/ota/firmware/:id/revoke` | `ota:firmware:write` | Thu hồi firmware đã phát hành khi không có job hoạt động. |
| `POST` | `/api/v1/devices/:id/ota` | `ota:jobs:create` | Tạo yêu cầu cập nhật firmware cho thiết bị. |
| `GET` | `/api/v1/ota/jobs` | `ota:jobs:read` | Tra cứu lịch sử OTA Job. |
| `GET` | `/ota/download/:token/:signature` | Token và chữ ký URL | Tải file firmware đã phát hành. |

### 7.1. Phân quyền và phạm vi dữ liệu

- `ota:firmware:write`: đăng ký, phát hành và thu hồi firmware.
- `ota:firmware:read`: xem danh sách firmware.
- `ota:jobs:create`: tạo OTA Job.
- `ota:jobs:read`: xem lịch sử OTA Job.
- Truy vấn theo `room_id` hoặc `device_id` phải tuân thủ phạm vi phòng của người dùng.
- Việc truy vấn lịch sử OTA tuân theo quy tắc giới hạn phạm vi được triển khai trong service.

---

## 8. Máy trạng thái OTA Job

### 8.1. Ý nghĩa trạng thái

| Trạng thái | Ý nghĩa |
|---|---|
| `PENDING` | Job được tạo và chờ xử lý. |
| `NOTIFIED` | Backend đã chuẩn bị/thông báo yêu cầu OTA. |
| `DOWNLOADING` | Thiết bị báo đang tải firmware. |
| `VERIFYING` | Thiết bị báo đang kiểm tra firmware. |
| `INSTALLING` | Thiết bị báo đang cài đặt firmware. |
| `REBOOTING` | Thiết bị báo đang khởi động lại. |
| `SUCCESS` | Backend nhận kết quả thành công hợp lệ. |
| `FAILED` | Cập nhật thất bại. |
| `ROLLED_BACK` | Thiết bị báo đã quay về phiên bản trước và phiên bản khớp dữ liệu Backend. |
| `CANCELLED` | Job bị hủy theo logic Backend/outbox. |
| `TIMEOUT` | Job hết thời hạn mà chưa hoàn tất hợp lệ. |

### 8.2. Chuyển trạng thái

| Trạng thái hiện tại | Trạng thái tiếp theo |
|---|---|
| `PENDING` | `NOTIFIED`, `FAILED`, `CANCELLED`, `TIMEOUT` |
| `NOTIFIED` | `DOWNLOADING`, `FAILED`, `CANCELLED`, `TIMEOUT` |
| `DOWNLOADING` | `VERIFYING`, `FAILED`, `TIMEOUT` |
| `VERIFYING` | `INSTALLING`, `FAILED`, `TIMEOUT` |
| `INSTALLING` | `REBOOTING`, `FAILED`, `TIMEOUT` |
| `REBOOTING` | `SUCCESS`, `FAILED`, `ROLLED_BACK`, `TIMEOUT` |

Các trạng thái kết thúc gồm `SUCCESS`, `FAILED`, `ROLLED_BACK`, `CANCELLED` và `TIMEOUT`. Job đã kết thúc không được chuyển sang trạng thái kết thúc khác. Tiến độ không được giảm so với giá trị đã lưu; `SUCCESS` yêu cầu tiến độ đạt 100%.

---

## 9. Bảo mật và tính toàn vẹn

### 9.1. Kiểm tra file firmware

- File firmware không được rỗng.
- Metadata được kiểm tra theo schema.
- Backend tính SHA-256 khi đăng ký firmware.
- Khi phát hành, Backend đọc lại file, kiểm tra kích thước và tính lại SHA-256.
- Nếu kích thước hoặc SHA-256 không khớp, Backend từ chối phát hành.
- Chỉ firmware `PUBLISHED` mới được sử dụng để tạo OTA Job hoặc tải qua endpoint download.
- Firmware đang có job hoạt động không được thu hồi.

### 9.2. Chữ ký Ed25519

Khi phát hành firmware, Backend ký giá trị SHA-256 bằng khóa riêng Ed25519. Chữ ký được lưu cùng bản ghi firmware và đưa vào lệnh OTA.

Chữ ký này cho phép phía thiết bị xác minh tính xác thực của hash bằng public key tương ứng. Tuy nhiên, mã nguồn Backend và kết quả kiểm thử hiện tại chưa chứng minh ESP32 thật đã thực hiện xác minh chữ ký.

### 9.3. Chữ ký HMAC-SHA256 cho URL tải

Chữ ký URL tải có mục đích khác với chữ ký firmware:

- HMAC-SHA256 bảo vệ token URL và dữ liệu firmware/storage path trong token.
- Token có thời điểm hết hạn.
- Backend kiểm tra chữ ký, hạn sử dụng, firmware còn `PUBLISHED`, storage path và kích thước file trước khi stream.

Không nhầm HMAC của URL tải với chữ ký Ed25519 của firmware.

### 9.4. Kiểm tra thiết bị và phiên

Trước khi tạo hoặc gửi OTA Job, Backend kiểm tra trạng thái vòng đời, kết nối, heartbeat, phòng, credential và session MQTT. Trạng thái OTA gửi về phải khớp thiết bị, phòng, job và session hợp lệ.

### 9.5. Audit và sự kiện nội bộ

Các thao tác quan trọng được ghi audit, gồm đăng ký firmware, phát hành, thu hồi, tạo OTA Job và cập nhật trạng thái OTA. Backend phát các sự kiện:

- `ota.firmware_published`
- `ota.firmware_revoked`
- `ota.job_created`
- `ota.job_updated`

---

## 10. Kiểm thử

### 10.1. Môi trường kiểm thử

Bộ integration test sử dụng Node.js Test Runner, PostgreSQL test database riêng và MQTT broker test riêng tại cổng `1885`. Fixture tạo thiết bị, credential, session, Backend runtime và firmware storage tạm thời.

Các biến môi trường kiểm thử gồm `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, `TEST_MQTT_URL` và `TEST_MQTT_ADMIN_PASSWORD`. Không sử dụng database hoặc broker production để chạy test.

### 10.2. Lệnh kiểm thử

```powershell
# Khởi tạo role và ACL MQTT test
npm run mqtt:bootstrap:test

# Chạy riêng 15 test OTA
npm run test:ota

# Chạy toàn bộ integration test
npm run test:integration
```

`npm run test:ota` thực thi:

```powershell
node --test tests/integration/ota.test.js
```

### 10.3. Các trường hợp kiểm thử OTA

Bộ `tests/integration/ota.test.js` hiện có 15 test case:

| STT | Trường hợp kiểm thử | Nội dung xác nhận |
|---:|---|---|
| 1 | Metadata UTF-8 dạng percent-encoded | Metadata tiếng Việt được chuyển đổi đúng; encoding sai bị từ chối. |
| 2 | Metadata Unicode đầy đủ và Base64 | Metadata Unicode độ dài lớn được xử lý; Base64/UTF-8 sai bị từ chối. |
| 3 | Tạo OTA Job và xử lý vòng đời qua MQTT | Tạo job, publish lệnh, nhận status, ACK, retry và cập nhật `SUCCESS`. |
| 4 | Đăng ký firmware hợp lệ | Tạo firmware `DRAFT`, có ID, SHA-256 và kích thước file. |
| 5 | Từ chối file firmware rỗng | File có kích thước 0 không được chấp nhận. |
| 6 | Từ chối firmware thiếu metadata | Thiếu metadata bắt buộc bị từ chối. |
| 7 | Phát hành firmware và tạo chữ ký | Firmware chuyển `PUBLISHED` và có chữ ký. |
| 8 | Không phát hành lại firmware đã phát hành | Lần publish thứ hai bị từ chối. |
| 9 | Thu hồi firmware đã phát hành | Firmware chuyển `REVOKED`. |
| 10 | Không thu hồi firmware chưa phát hành | Firmware `DRAFT` không được thu hồi. |
| 11 | Danh sách firmware theo quyền | API trả dữ liệu phù hợp quyền truy cập. |
| 12 | Từ chối API quản lý khi không có token | Request không xác thực bị từ chối. |
| 13 | URL tải firmware có chữ ký hợp lệ | Token và chữ ký hợp lệ được xác minh. |
| 14 | Từ chối URL tải sai chữ ký | Chữ ký không hợp lệ bị từ chối. |
| 15 | Từ chối URL tải hết hạn | Token hết hạn bị từ chối. |

### 10.4. Kết quả kiểm thử thực tế trên máy phát triển

Trong lần chạy riêng đầu tiên, bộ OTA có kết quả:

| Chỉ tiêu | Kết quả |
|---|---:|
| Tổng số test | 15 |
| PASS | 14 |
| FAIL | 1 |

Test thất bại:

`OTA: API creates a job, publishes MQTT and persists status through SUCCESS`

Lỗi ghi nhận:

```text
ErrorWithSubackPacket: Subscribe error: Not authorized
granted: [135, 135]
```

Nguyên nhân được xác định ở cấu hình quyền Subscribe của MQTT broker kiểm thử. Sau khi chạy:

```powershell
npm run mqtt:bootstrap:test
```

role và ACL của broker kiểm thử được khởi tạo/cập nhật lại.

Sau đó, nhóm chạy lại toàn bộ integration test:

```powershell
npm run test:integration
```

Kết quả lần chạy sau:

| Chỉ tiêu | Kết quả |
|---|---:|
| Tổng số test | 106 |
| PASS | 106 |
| FAIL | 0 |
| Cancelled | 0 |
| Skipped | 0 |

Trong lần chạy integration test này, toàn bộ 15 test OTA đều PASS, bao gồm test tạo OTA Job, trao đổi MQTT, xử lý trạng thái đến `SUCCESS` và kiểm tra ACK/retry.

### 10.5. Kết quả GitHub Actions

Tại commit `f951fc159eab76475d420b4e283def130beedd5b` trên nhánh `main`, các workflow được kiểm tra có kết quả:

| Workflow | Kết quả | Nội dung |
|---|---|---|
| Backend checks | Success | Unit test Node.js 22, Node.js 24, integration test và deployment checks. |
| ESP32 Firmware Build | Success | Build firmware cho Sensor Node và Control Node theo cấu hình CI. |

Các lần chạy:

- [Backend checks — run 42593209896](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/actions/runs/42593209896)
- [ESP32 Firmware Build — run 42593210564](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/actions/runs/42593210564)

Kết quả CI xác nhận các bước tự động trong workflow đã thành công. Firmware build thành công chỉ chứng minh mã nguồn biên dịch được theo cấu hình CI; không chứng minh thiết bị thật đã tải, xác minh, cài đặt hoặc rollback firmware.

### 10.6. Phạm vi kiểm thử đã và chưa xác nhận

**Đã xác nhận bằng kiểm thử tự động:**

- API đăng ký, phát hành và thu hồi firmware.
- Kiểm tra metadata, SHA-256 và chữ ký.
- Phân quyền API cơ bản.
- Xác minh URL tải hợp lệ, sai chữ ký và hết hạn.
- Tạo OTA Job và gửi lệnh qua MQTT trong môi trường integration.
- Nhận các trạng thái OTA và cập nhật dữ liệu Backend.
- Xử lý ACK và gửi lại trạng thái trong kịch bản test.
- Unit test, integration test và deployment checks trong CI.
- Build firmware Sensor Node và Control Node trong CI.

**Chưa xác nhận trên phần cứng thật:**

- ESP32 tải firmware qua HTTPS.
- ESP32 xác minh Ed25519 và SHA-256.
- Ghi firmware vào OTA partition.
- Chuyển boot partition và reboot.
- Firmware mới hoạt động sau reboot.
- Bootloader rollback khi firmware mới không khởi động được.

Kết quả `106/106 PASS` là kết quả kiểm thử tự động phần mềm/integration, không phải nghiệm thu OTA end-to-end trên ESP32.

---

## 11. Hạn chế hiện tại

1. **Chưa nghiệm thu firmware OTA trên ESP32 thật:** Backend có hợp đồng gửi lệnh và nhận trạng thái, nhưng chưa có bằng chứng quy trình OTA hoàn chỉnh chạy trên phần cứng.
2. **Chưa xác minh ghi OTA partition:** chưa có kết quả chứng minh firmware mới được ghi vào phân vùng OTA và boot partition được chuyển đúng.
3. **Chưa xác minh chữ ký trên thiết bị:** Backend tạo chữ ký Ed25519, nhưng chưa có bằng chứng ESP32 xác minh bằng public key tương ứng.
4. **Chưa kiểm thử tải firmware trên thiết bị thật:** endpoint HTTPS đã có, nhưng chưa xác nhận thiết bị thật tải file thành công.
5. **Chưa kiểm thử reboot và firmware mới:** trạng thái `REBOOTING`/`SUCCESS` đã được Backend xử lý theo hợp đồng MQTT và test mô phỏng, chưa chứng minh hành vi phần cứng.
6. **Chưa kiểm thử rollback vật lý:** Backend có trạng thái `ROLLED_BACK` và kiểm tra phiên bản báo về, nhưng chưa có bằng chứng bootloader thực hiện rollback.
7. **Firmware Storage dùng local filesystem:** `LocalFirmwareStorage` lưu file cục bộ; chưa xác nhận object storage hoặc cơ chế chia sẻ file giữa nhiều Backend instance.
8. **URL download có thời hạn:** thời hạn mặc định trong `OtaService` là 300 giây; cần kiểm tra với kích thước firmware và tốc độ mạng thực tế.
9. **Timeout job là cấu hình Backend:** thời hạn mặc định là 900 giây; cần đánh giá theo thời gian tải và cài đặt trên thiết bị thật.
10. **Chưa nghiệm thu bảo mật OTA đầu cuối:** cần kiểm tra bảo vệ private key, phân phối public key, chống downgrade, mất điện khi ghi flash và firmware không đáng tin cậy.
11. **Chưa nghiệm thu TLS trên thiết bị:** cần xác nhận thiết bị thật sử dụng HTTPS/MQTT TLS và kiểm tra CA/hostname đúng môi trường triển khai.
12. **Chưa có frontend OTA được nghiệm thu:** API Backend đã có, nhưng README ghi frontend chưa nghiệm thu.

---

## 12. Công việc cần thực hiện tiếp theo

### 12.1. Tích hợp firmware ESP32

- Tích hợp OTA handler cho Sensor Node và Control Node.
- Tiếp nhận và validate lệnh OTA theo MQTT contract.
- Kiểm tra `job_id`, `firmware_id`, `device_id`, `room_id`, `session_id` và `expires_at`.
- Tải firmware từ HTTPS download URL.
- Kiểm tra kích thước file và SHA-256.
- Xác minh chữ ký Ed25519 bằng public key tương ứng.
- Ghi firmware bằng cơ chế OTA partition phù hợp với board ESP32.
- Chỉ chuyển boot partition sau khi kiểm tra file thành công.
- Reboot và xác nhận firmware mới khởi động.
- Gửi trạng thái OTA qua topic `ota/status`.
- Xây dựng cơ chế rollback khi firmware mới không hoạt động theo tiêu chí xác định.
- Xử lý lệnh lặp, mất mạng và reconnect trong quá trình OTA.

### 12.2. Hoàn thiện hợp đồng Backend – Firmware

- Chốt schema payload `ota/command` và `ota/status`.
- Thống nhất định dạng chữ ký Ed25519 và public key.
- Quy định thứ tự trạng thái và tiến độ.
- Kiểm tra session thay đổi sau reboot khi job ở `REBOOTING`.
- Đánh giá timeout theo kích thước firmware và chất lượng mạng.
- Kiểm thử retry download, mất ACK/status và reconnect.
- Xác định chính sách nâng cấp, cài lại cùng phiên bản và chống downgrade.
- Xem xét storage phù hợp khi triển khai nhiều Backend instance.

### 12.3. Kiểm thử đầu cuối trên phần cứng

- Build firmware OTA cho đúng board ESP32.
- Cập nhật trên Sensor Node thật.
- Cập nhật trên Control Node thật nếu phần cứng và firmware hỗ trợ.
- Kiểm tra firmware đúng, sai hash và sai chữ ký.
- Ngắt Wi-Fi/MQTT trong các giai đoạn tải và cài đặt.
- Kiểm tra mất nguồn khi tải hoặc ghi firmware.
- Kiểm tra reboot và xác nhận firmware mới hoạt động.
- Kiểm tra Backend cập nhật đúng `firmware_version`.
- Tạo tình huống boot lỗi để kiểm tra rollback.
- Kiểm tra URL hết hạn và quy trình retry.
- Kiểm tra timeout, firmware bị thu hồi và thiết bị bị revoke trong quá trình OTA.

---

## 13. Kết luận

ADV-05 hiện đã có nền tảng Backend cho chức năng cập nhật firmware từ xa. Hệ thống hỗ trợ đăng ký và quản lý firmware, tính SHA-256, ký hash bằng Ed25519, phát hành/thu hồi firmware, lưu file, tạo URL tải có chữ ký và thời hạn, tạo OTA Job, gửi lệnh qua MQTT bằng outbox, nhận trạng thái OTA và quản lý tiến độ/kết quả trong PostgreSQL.

Backend kiểm tra quyền truy cập, trạng thái thiết bị, phòng học, heartbeat, session MQTT và credential version trước khi tạo hoặc gửi OTA Job. Cơ chế MQTT Dynamic Security cấp role và ACL riêng cho Backend, Sensor Node và Control Node.

Bộ kiểm thử OTA hiện có 15 test case. Sau khi khởi tạo lại ACL MQTT broker kiểm thử, cả 15 test OTA và 106 test integration đều PASS. Các workflow Backend checks và ESP32 Firmware Build cũng đã thành công tại commit được ghi nhận trong tài liệu.

Tuy nhiên, các kết quả này chưa chứng minh quy trình OTA hoàn chỉnh trên phần cứng. Việc tải firmware, xác minh chữ ký trên ESP32, ghi OTA partition, reboot và rollback thực tế vẫn cần được kiểm thử và nghiệm thu.

**Đánh giá trạng thái ADV-05:** Phần Backend và kiểm thử tự động trong phạm vi repository đã được triển khai và xác nhận. Phần OTA end-to-end trên ESP32 thật vẫn chưa được xác nhận, do đó chưa đánh dấu toàn bộ chức năng OTA hoàn tất trên phần cứng.
