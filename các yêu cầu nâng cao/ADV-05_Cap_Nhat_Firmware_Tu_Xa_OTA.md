# ADV-05 — Cập nhật firmware từ xa (OTA)

**Mã chức năng:** ADV-05  
**Tên chức năng:** Cập nhật firmware từ xa (Over-the-Air Firmware Update)  
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Phạm vi tài liệu:** Phần Backend OTA hiện có trong repository, cơ sở dữ liệu, giao tiếp MQTT, lưu trữ firmware và kiểm thử tự động.  
**Trạng thái:** Đã có triển khai Backend cho quản lý firmware, phát hành/thu hồi firmware, tạo OTA Job, gửi lệnh qua MQTT, nhận trạng thái OTA và cung cấp file firmware có kiểm tra chữ ký URL. Chưa có bằng chứng về firmware OTA chạy trên ESP32 thật hoặc kiểm thử cập nhật phần cứng đầu cuối.

> **Giới hạn quan trọng:** Repository hiện được mô tả là Backend của hệ thống. README xác nhận chưa nghiệm thu ESP32/relay thật và frontend. Vì vậy, các phần firmware ESP32, ghi firmware vào OTA partition, xác minh chữ ký trên thiết bị, reboot và rollback thực tế không được xem là đã hoàn thành chỉ dựa trên Backend hoặc test MQTT mô phỏng.

---

## 1. Tổng quan

### 1.1. Mục tiêu

ADV-05 cung cấp cơ chế quản lý và cập nhật firmware từ xa cho các thiết bị IoT trong hệ thống phòng học thông minh. Backend quản lý các bản firmware, kiểm tra tính toàn vẹn của file, phát hành firmware, tạo yêu cầu cập nhật cho thiết bị, gửi lệnh OTA qua MQTT và tiếp nhận tiến độ/kết quả cập nhật.

Chức năng hướng tới việc quản lý tập trung phiên bản firmware theo loại thiết bị và mục tiêu phần cứng, theo dõi vòng đời của từng lần cập nhật và lưu lại lịch sử phục vụ giám sát.

### 1.2. Đối tượng áp dụng

Theo mã nguồn và migration hiện tại, ADV-05 hỗ trợ hai loại thiết bị:

- `SENSOR_NODE`
- `CONTROL_NODE`

Mỗi bản firmware được gắn với `device_type` và `hardware_target`. Khi tạo OTA Job, Backend kiểm tra loại thiết bị và phiên bản phần cứng của thiết bị đích có khớp với bản firmware hay không.

### 1.3. Phạm vi đã triển khai ở Backend

- Tiếp nhận file firmware và metadata.
- Tính SHA-256 cho file firmware.
- Lưu file trong vùng lưu trữ firmware riêng.
- Quản lý trạng thái firmware: `DRAFT`, `PUBLISHED`, `REVOKED`.
- Ký hash firmware bằng khóa Ed25519 khi phát hành.
- Tạo URL tải firmware có chữ ký HMAC và thời hạn.
- Cung cấp endpoint tải file firmware, chỉ cho phép tải firmware đang `PUBLISHED` và kiểm tra kích thước file.
- Tạo OTA Job cho thiết bị phù hợp và đang kết nối.
- Gửi lệnh OTA qua MQTT topic riêng của thiết bị.
- Dùng outbox trong PostgreSQL để thử gửi lại lệnh khi broker hoặc thiết bị tạm thời chưa sẵn sàng.
- Nhận trạng thái OTA từ thiết bị qua MQTT topic `ota/status`.
- Kiểm tra job, thiết bị, phiên MQTT và credential trước khi chấp nhận trạng thái.
- Theo dõi tiến độ, trạng thái kết thúc, lỗi và timeout.
- Cập nhật `firmware_version` của thiết bị khi nhận kết quả `SUCCESS` hợp lệ.
- Ghi audit và phát sự kiện nội bộ khi firmware/job thay đổi.

### 1.4. Phần chưa được xác nhận

- Firmware ESP32 thực hiện quy trình OTA.
- ESP32 tải file firmware qua HTTPS.
- ESP32 xác minh chữ ký Ed25519 của firmware.
- ESP32 kiểm tra SHA-256 trước khi cài đặt.
- Ghi firmware vào OTA partition và chuyển boot partition.
- Reboot thiết bị sau khi cài đặt.
- Xác nhận firmware mới hoạt động sau reboot.
- Rollback thực tế khi firmware mới khởi động thất bại.
- Kiểm thử cập nhật trên Sensor Node và Control Node thật.

---

## 2. Kiến trúc và thành phần

ADV-05 hiện có ba nhóm thành phần chính:

1. **Backend OTA:** quản lý firmware, kiểm tra thiết bị, tạo job, gửi lệnh và xử lý trạng thái.
2. **PostgreSQL:** lưu metadata firmware, OTA Job và hàng đợi lệnh OTA.
3. **MQTT và Firmware Storage:** MQTT truyền lệnh/trạng thái; vùng lưu trữ giữ file firmware để thiết bị tải xuống.

Luồng Backend hiện tại có thể mô tả như sau:

```text
Admin/Operator
     |
     | HTTP API
     v
Backend OTA Service
     |
     +------ PostgreSQL
     |        - firmware_releases
     |        - ota_jobs
     |        - ota_command_outbox
     |
     +------ Firmware Storage
     |        - file .bin
     |
     +------ MQTT Broker
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

Sơ đồ trên mô tả phần tích hợp Backend đã có trong source. Việc thiết bị thực sự tải, xác minh và cài đặt firmware cần firmware OTA tương ứng; chưa có bằng chứng xác nhận phần đó trong repository.

## 3. Cấu trúc source code liên quan

```text
source code IoT/
├── package.json
├── database/
│   └── migrations/
│       └── 017_ota_management.sql
├── backend/
│   └── src/
│       ├── mqtt/
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
    └── integration/
        └── ota.test.js
```

### 3.1. Trách nhiệm từng file

| File | Trách nhiệm |
|---|---|
| `database/migrations/017_ota_management.sql` | Tạo bảng `firmware_releases`, `ota_jobs` và các index/ràng buộc phục vụ quản lý firmware, job OTA. |
| `ota.service.js` | Xử lý nghiệp vụ đăng ký, phát hành, thu hồi firmware; kiểm tra thiết bị; tạo OTA Job; xử lý trạng thái MQTT; gửi lệnh; retry và timeout. |
| `ota.routes.js` | Khai báo HTTP API quản lý firmware và OTA Job; xác thực quyền, validate metadata, query và request body. |
| `ota.repository.pg.js` | Thực hiện truy vấn PostgreSQL cho firmware, OTA Job, credential/session và outbox; kiểm tra chuyển trạng thái job. |
| `ota.storage.js` | Lưu, đọc, kiểm tra thông tin file và xóa file firmware trong thư mục lưu trữ cục bộ. |
| `ota.download-signer.js` | Tạo và xác minh URL tải firmware có chữ ký HMAC-SHA256, có thời hạn. |
| `ota.download.routes.js` | Xác minh token tải, kiểm tra firmware còn được phát hành, đối chiếu storage path/kích thước và stream file về thiết bị. |
| `mqtt/runtime.js` | Subscribe các topic thiết bị, bao gồm `ota/status`; phân tích topic/payload và chuyển sự kiện tới handler. |
| `tests/integration/ota.test.js` | Kiểm thử các API và nghiệp vụ OTA thông qua integration fixture của Backend. |
| `package.json` | Khai báo lệnh `npm run test:ota` để chạy bộ kiểm thử OTA. |

---

## 4. Cơ sở dữ liệu

Migration `017_ota_management.sql` tạo hai bảng nghiệp vụ chính.

### 4.1. Bảng `firmware_releases`

Bảng lưu thông tin các bản firmware được đăng ký trong hệ thống.

| Trường | Ý nghĩa |
|---|---|
| `firmware_id` | UUID định danh bản firmware. |
| `version` | Phiên bản firmware. |
| `device_type` | Loại thiết bị: `SENSOR_NODE` hoặc `CONTROL_NODE`. |
| `hardware_target` | Mục tiêu/phiên bản phần cứng tương thích. |
| `file_name` | Tên file firmware được cung cấp. |
| `storage_path` | Đường dẫn lưu file trong vùng lưu trữ. |
| `file_size` | Kích thước file, phải lớn hơn 0. |
| `sha256` | SHA-256 của nội dung file. |
| `release_notes` | Ghi chú phát hành. |
| `status` | Trạng thái `DRAFT`, `PUBLISHED` hoặc `REVOKED`. |
| `created_by` | Người đăng ký firmware. |
| `created_at` | Thời điểm đăng ký. |
| `published_at` | Thời điểm phát hành; NULL khi còn DRAFT. |

Các ràng buộc đáng chú ý:

- Chỉ chấp nhận `SENSOR_NODE` và `CONTROL_NODE`.
- `file_size` phải lớn hơn 0.
- `sha256` phải có 64 ký tự hexadecimal.
- Một tổ hợp `device_type`, `hardware_target`, `version` không được trùng.
- Firmware `DRAFT` chưa có `published_at`; firmware `PUBLISHED` hoặc `REVOKED` phải có `published_at`.

### 4.2. Bảng `ota_jobs`

Bảng lưu từng yêu cầu cập nhật firmware cho một thiết bị.

| Trường | Ý nghĩa |
|---|---|
| `job_id` | UUID định danh OTA Job. |
| `firmware_id` | Bản firmware được yêu cầu cài đặt. |
| `device_id` | Thiết bị đích. |
| `room_id` | Phòng học chứa thiết bị tại thời điểm tạo job. |
| `session_id` | Phiên MQTT của thiết bị khi tạo job. |
| `credential_version` | Phiên bản credential được dùng khi tạo job. |
| `previous_firmware_version` | Phiên bản firmware trước khi cập nhật. |
| `status` | Trạng thái tiến trình OTA. |
| `progress` | Tiến độ từ 0 đến 100. |
| `error_code` | Mã lỗi nếu có. |
| `requested_by` | Người yêu cầu cập nhật. |
| `created_at` | Thời điểm tạo job. |
| `started_at` | Thời điểm bắt đầu tải firmware. |
| `last_status_at` | Thời điểm nhận trạng thái gần nhất. |
| `finished_at` | Thời điểm kết thúc. |
| `timeout_at` | Thời điểm hết hạn job. |

Các trạng thái được khai báo trong migration:

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

Ràng buộc dữ liệu:

- Tiến độ phải nằm trong khoảng 0–100.
- Mỗi thiết bị chỉ có tối đa một OTA Job đang hoạt động.
- Job ở trạng thái kết thúc phải có `finished_at`.
- Job chưa kết thúc không được có `finished_at`.

### 4.3. Hàng đợi lệnh OTA

Repository sử dụng bảng `ota_command_outbox` để lưu và xử lý lệnh OTA cần gửi qua MQTT. Bảng này được sử dụng cùng với `ota_jobs` nhằm tránh phụ thuộc vào việc publish MQTT ngay tại thời điểm transaction nghiệp vụ được tạo.

Outbox có các trạng thái xử lý như `PENDING`, `PROCESSING`, `SENT`, `CANCELLED`; có số lần thử, thời điểm được phép thử tiếp theo, thời hạn khóa xử lý và thông tin lỗi gần nhất. Đây là bảng thuộc hạ tầng outbox dùng chung/được mở rộng bởi migration liên quan, không phải một trong hai bảng nghiệp vụ chính được tạo trong migration 017.

---

## 5. Quy trình hoạt động

### 5.1. Đăng ký firmware

1. Người có quyền quản lý firmware gửi file firmware cùng metadata qua HTTP API.
2. Backend kiểm tra metadata gồm phiên bản, loại thiết bị, mục tiêu phần cứng, tên file và ghi chú phát hành.
3. Backend kiểm tra file được cung cấp hợp lệ và không rỗng.
4. Backend tính SHA-256 và kích thước file.
5. File được lưu trong `LocalFirmwareStorage` dưới tên UUID có phần mở rộng `.bin`.
6. Backend tạo bản ghi firmware ở trạng thái `DRAFT` trong PostgreSQL.
7. Backend ghi audit cho thao tác đăng ký.
8. Nếu transaction đăng ký metadata thất bại, Backend cố gắng xóa file đã lưu để tránh file mồ côi.

### 5.2. Phát hành firmware

1. Người có quyền quản lý chọn firmware ở trạng thái `DRAFT`.
2. Backend khóa bản ghi firmware trong transaction.
3. Backend đọc lại file từ vùng lưu trữ.
4. Backend kiểm tra file tồn tại, kích thước thực tế khớp `file_size`.
5. Backend tính lại SHA-256 và đối chiếu với hash đã lưu.
6. Backend ký giá trị hash bằng khóa riêng Ed25519.
7. Backend chuyển firmware sang `PUBLISHED`, lưu chữ ký và `published_at`.
8. Backend ghi audit và phát sự kiện nội bộ `ota.firmware_published`.

Firmware đã `PUBLISHED` không thể phát hành lại bằng API publish hiện tại.

### 5.3. Yêu cầu cập nhật cho thiết bị

1. Người có quyền tạo OTA Job chọn thiết bị và firmware đã phát hành.
2. Backend kiểm tra quyền truy cập thiết bị/phòng.
3. Backend kiểm tra thiết bị đang ở `PROVISIONED` hoặc `ACTIVE`, kết nối `ONLINE`, có heartbeat còn mới và có session MQTT hợp lệ.
4. Backend kiểm tra phòng học đang `ACTIVE`.
5. Backend kiểm tra credential của thiết bị đã đồng bộ với broker (`SYNCED`).
6. Backend kiểm tra firmware đang `PUBLISHED`.
7. Backend đối chiếu `device_type` và `hardware_version` của thiết bị với `device_type` và `hardware_target` của firmware.
8. Backend từ chối nếu thiết bị đã có OTA Job đang hoạt động.
9. Backend tạo OTA Job, lưu `session_id`, `credential_version`, firmware trước cập nhật và thời hạn job.
10. Backend chuyển job sang `NOTIFIED`, ghi audit, phát sự kiện `ota.job_created` và tạo bản ghi outbox.
11. Backend xử lý outbox để gửi lệnh OTA qua MQTT.

### 5.4. Gửi lệnh OTA qua MQTT

Backend tạo URL tải firmware có thời hạn, sau đó publish lệnh tới topic:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/command
```

Payload lệnh OTA được xây dựng từ dữ liệu job và firmware, gồm các trường chính:

```json
{
  "job_id": "UUID",
  "firmware_id": "UUID",
  "device_id": "SENSOR_01",
  "room_id": "ROOM_302",
  "session_id": "session-current",
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

Đây là cấu trúc minh họa các trường mà service đưa vào payload publish; URL và giá trị thực tế được tạo theo cấu hình/mỗi lần yêu cầu, không phải các giá trị cố định.

Trước khi gửi, Backend kiểm tra lại:

- Firmware vẫn ở trạng thái `PUBLISHED`.
- Loại thiết bị và mục tiêu phần cứng vẫn tương thích.
- Thiết bị còn ở trạng thái vòng đời cho phép.
- Phòng học vẫn hoạt động.
- Thiết bị vẫn ONLINE và heartbeat chưa quá hạn.
- Session hiện tại khớp session đã lưu trong OTA Job.
- Credential đang hoạt động có version khớp job.

Nếu broker hoặc thiết bị tạm thời chưa sẵn sàng, outbox được đưa về `PENDING` và thử lại với khoảng chờ tăng dần, tối đa 30 giây theo logic hiện tại. Lỗi không thể thử lại sẽ kết thúc job ở `FAILED` và hủy bản ghi outbox tương ứng.

MQTT publish thành công chỉ xác nhận Backend đã gửi lệnh tới broker; không chứng minh thiết bị đã tải hoặc cài đặt firmware thành công.

### 5.5. Thiết bị tải firmware

Backend cung cấp endpoint tải file qua HTTPS. URL tải có token và chữ ký HMAC-SHA256 kèm thời điểm hết hạn.

Khi có yêu cầu tải, Backend:

1. Xác minh chữ ký URL bằng HMAC-SHA256 và so sánh an toàn.
2. Kiểm tra token chưa hết hạn và chứa firmware ID/storage path hợp lệ.
3. Truy vấn firmware trong database với điều kiện `status = 'PUBLISHED'`.
4. Đối chiếu storage path trong token với storage path trong database.
5. Kiểm tra file tồn tại, là file hợp lệ, kích thước lớn hơn 0 và bằng `file_size` đã lưu.
6. Stream file với `Content-Type: application/octet-stream`, `Content-Length`, `Cache-Control: no-store` và `X-Content-Type-Options: nosniff`.

**Lưu ý về hai loại chữ ký:**

- `signature` lưu trong firmware release là chữ ký Ed25519 của SHA-256 firmware, được tạo khi phát hành.
- Chữ ký trong URL tải là HMAC-SHA256 dùng để xác thực token URL và thời hạn tải.

Hai chữ ký phục vụ hai mục đích khác nhau. Việc Backend tạo chữ ký Ed25519 chưa chứng minh ESP32 đã có mã xác minh chữ ký đó.

### 5.6. Nhận trạng thái OTA

Backend subscribe topic trạng thái OTA:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/status
```

Payload trạng thái được kiểm tra theo schema, gồm:

- `job_id`
- `device_id`
- `room_id`
- `session_id`
- `status`
- `progress` (nếu có)
- `error_code` (nếu có)
- `version` (nếu có)
- `timestamp`

Các trạng thái mà schema hiện tại chấp nhận từ thiết bị:

- `DOWNLOADING`
- `VERIFYING`
- `INSTALLING`
- `REBOOTING`
- `SUCCESS`
- `FAILED`
- `ROLLED_BACK`

Backend kiểm tra topic và payload, thiết bị tồn tại, trạng thái vòng đời cho phép, broker credential còn đồng bộ, session hiện tại hợp lệ, job thuộc thiết bị và credential version không bị thay đổi.

Khi nhận `SUCCESS`, Backend yêu cầu phiên bản báo về khớp phiên bản firmware của job và tiến độ bằng 100. Sau đó Backend cập nhật `devices.firmware_version`.

Khi nhận `ROLLED_BACK`, Backend yêu cầu phiên bản báo về khớp `previous_firmware_version` đã lưu trong job rồi cập nhật lại phiên bản firmware của thiết bị.

Các lần cập nhật trạng thái được ghi audit và phát sự kiện nội bộ `ota.job_updated`.

### 5.7. Timeout

OTA Job có thời hạn mặc định 900 giây theo constructor của `OtaService`. Backend có logic tìm các job quá hạn và chuyển sang `TIMEOUT`, đặt `error_code = OTA_TIMEOUT`, kết thúc outbox chưa gửi và phát sự kiện cập nhật job.

Không được hiểu timeout của Backend là thiết bị đã rollback; `TIMEOUT` chỉ thể hiện Backend không nhận được tiến trình/kết quả hợp lệ trước thời hạn.

### 5.8. Thu hồi firmware

1. Người có quyền quản lý chọn firmware đang `PUBLISHED`.
2. Backend khóa bản ghi firmware.
3. Backend chỉ cho phép thu hồi khi firmware không có OTA Job đang hoạt động.
4. Nếu còn job hoạt động, Backend trả lỗi xung đột `FIRMWARE_IN_USE`.
5. Nếu hợp lệ, firmware chuyển sang `REVOKED`.
6. Backend ghi audit và phát sự kiện `ota.firmware_revoked`.

Firmware `DRAFT` không thể thu hồi bằng API hiện tại; chỉ firmware đã phát hành mới được thu hồi.

---

## 6. API Backend

Các route được khai báo trong `backend/src/modules/ota/ota.routes.js`. Tất cả API quản lý OTA đều yêu cầu xác thực và quyền tương ứng.

| Method | Endpoint | Quyền | Chức năng |
|---|---|---|---|
| `POST` | `/api/v1/ota/firmware` | `ota:firmware:write` | Đăng ký file firmware và metadata; trả về bản ghi `DRAFT`. |
| `GET` | `/api/v1/ota/firmware` | `ota:firmware:read` | Danh sách firmware; hỗ trợ lọc loại thiết bị, mục tiêu phần cứng, trạng thái và phân trang. |
| `POST` | `/api/v1/ota/firmware/:id/publish` | `ota:firmware:write` | Kiểm tra hash, ký Ed25519 và phát hành firmware. |
| `POST` | `/api/v1/ota/firmware/:id/revoke` | `ota:firmware:write` | Thu hồi firmware đã phát hành nếu không có job đang hoạt động. |
| `POST` | `/api/v1/devices/:id/ota` | `ota:jobs:create` | Tạo yêu cầu cập nhật firmware cho thiết bị. |
| `GET` | `/api/v1/ota/jobs` | `ota:jobs:read` | Tra cứu lịch sử OTA Job theo thiết bị/phòng/trạng thái và phân trang. |

Endpoint tải firmware được khai báo riêng trong `ota.download.routes.js`:

```text
GET /ota/download/:token/:signature
```

Endpoint này sử dụng token tải có chữ ký; không phải API đăng ký hoặc quản lý firmware.

### 6.1. Phân quyền và phạm vi dữ liệu

- Quyền quản lý firmware được kiểm tra qua `ota:firmware:write`.
- Quyền xem firmware được kiểm tra qua `ota:firmware:read`.
- Quyền tạo OTA Job được kiểm tra qua `ota:jobs:create`.
- Quyền xem lịch sử job được kiểm tra qua `ota:jobs:read`.
- Khi tra cứu job theo `room_id` hoặc `device_id`, Backend kiểm tra phạm vi phòng của người dùng.
- Người không phải ADMIN phải chỉ định phòng hoặc thiết bị khi truy vấn lịch sử OTA; không được truy vấn toàn bộ job.

---

## 7. Máy trạng thái OTA Job

### 7.1. Trạng thái

| Trạng thái | Ý nghĩa |
|---|---|
| `PENDING` | Job mới được tạo, chờ xử lý. |
| `NOTIFIED` | Backend đã chuẩn bị/thông báo yêu cầu OTA và chờ thiết bị thực hiện. |
| `DOWNLOADING` | Thiết bị báo đang tải firmware. |
| `VERIFYING` | Thiết bị báo đang kiểm tra firmware. |
| `INSTALLING` | Thiết bị báo đang cài đặt firmware. |
| `REBOOTING` | Thiết bị báo đang khởi động lại. |
| `SUCCESS` | Thiết bị báo cập nhật thành công và thỏa điều kiện phiên bản/tiến độ. |
| `FAILED` | Cập nhật thất bại. |
| `ROLLED_BACK` | Thiết bị báo đã quay về firmware trước đó và phiên bản khớp dữ liệu Backend. |
| `CANCELLED` | Job bị hủy theo logic xử lý Backend/outbox. |
| `TIMEOUT` | Job hết thời hạn mà chưa hoàn tất hợp lệ. |

### 7.2. Chuyển trạng thái được repository cho phép

| Trạng thái hiện tại | Trạng thái tiếp theo được cho phép |
|---|---|
| `PENDING` | `NOTIFIED`, `FAILED`, `CANCELLED`, `TIMEOUT` |
| `NOTIFIED` | `DOWNLOADING`, `FAILED`, `CANCELLED`, `TIMEOUT` |
| `DOWNLOADING` | `VERIFYING`, `FAILED`, `TIMEOUT` |
| `VERIFYING` | `INSTALLING`, `FAILED`, `TIMEOUT` |
| `INSTALLING` | `REBOOTING`, `FAILED`, `TIMEOUT` |
| `REBOOTING` | `SUCCESS`, `FAILED`, `ROLLED_BACK`, `TIMEOUT` |

Các trạng thái kết thúc là `SUCCESS`, `FAILED`, `ROLLED_BACK`, `CANCELLED`, `TIMEOUT`. Job đã kết thúc không thể chuyển sang trạng thái kết thúc khác.

Tiến độ không được giảm so với giá trị đã lưu. `SUCCESS` chỉ được chấp nhận khi tiến độ đạt 100%.

---

## 8. Kiểm tra an toàn và tính toàn vẹn

### 8.1. Kiểm tra firmware ở Backend

- File không được rỗng.
- Metadata được validate theo schema.
- Kích thước file được lưu cùng metadata.
- SHA-256 được tính khi đăng ký.
- Khi phát hành, Backend đọc lại file và tính lại SHA-256.
- Nếu kích thước hoặc SHA-256 không khớp, Backend từ chối phát hành.
- Chỉ firmware `PUBLISHED` mới được dùng để tạo OTA Job hoặc tải qua endpoint download.
- Firmware đang có job hoạt động không được thu hồi.

### 8.2. Chữ ký và URL tải

- Firmware hash được ký bằng Ed25519.
- URL tải dùng HMAC-SHA256, có thời hạn mặc định 300 giây theo constructor `OtaService`.
- URL tải được kiểm tra chữ ký, hạn sử dụng, firmware ID và storage path.
- Endpoint kiểm tra file thực tế trước khi stream.
- Response không cache nội dung firmware.

### 8.3. Kiểm tra thiết bị và phiên

Trước khi tạo job và trước khi gửi lệnh, Backend kiểm tra:

- Thiết bị thuộc loại được hỗ trợ.
- Firmware phù hợp với loại thiết bị và hardware target.
- Thiết bị ở trạng thái vòng đời `PROVISIONED` hoặc `ACTIVE`.
- Phòng học ở trạng thái `ACTIVE`.
- Thiết bị `ONLINE`, có heartbeat còn mới.
- MQTT broker đã đồng bộ credential.
- Session MQTT hiện tại còn hợp lệ.
- Credential version khớp với version được lưu trong job.

OTA status phải khớp thiết bị, phòng, job, session và credential hợp lệ. Các điều kiện này giúp ngăn trạng thái từ phiên cũ hoặc thiết bị khác cập nhật nhầm OTA Job.

### 8.4. Audit và sự kiện nội bộ

Các thao tác chính được ghi audit:

- Đăng ký firmware.
- Phát hành firmware.
- Thu hồi firmware.
- Tạo OTA Job.
- Cập nhật trạng thái OTA từ thiết bị.

Backend cũng phát các sự kiện nội bộ:

- `ota.firmware_published`
- `ota.firmware_revoked`
- `ota.job_created`
- `ota.job_updated`

---

## 9. Kiểm thử

### 9.1. Lệnh kiểm thử

Repository khai báo:

```powershell
npm run test:ota
```

Lệnh này chạy:

```powershell
node --test tests/integration/ota.test.js
```

### 9.2. Các trường hợp có trong bộ test

| STT | Trường hợp kiểm thử | Nội dung xác nhận |
|---:|---|---|
| 1 | Đăng ký firmware hợp lệ | API trả 201, trạng thái `DRAFT`, có firmware ID, SHA-256 và kích thước file. |
| 2 | Từ chối file firmware rỗng | Không chấp nhận file có kích thước 0. |
| 3 | Từ chối firmware thiếu metadata | API trả lỗi đầu vào khi thiếu metadata bắt buộc. |
| 4 | Phát hành firmware và tạo chữ ký | Firmware chuyển `PUBLISHED` và có chữ ký. |
| 5 | Không phát hành lại firmware đã phát hành | Lần publish thứ hai bị từ chối với 409. |
| 6 | Thu hồi firmware đã phát hành | Firmware chuyển `REVOKED`. |
| 7 | Không thu hồi firmware chưa phát hành | Firmware `DRAFT` không được thu hồi. |
| 8 | Danh sách firmware theo quyền | API trả danh sách firmware cho người dùng hợp lệ. |
| 9 | Từ chối API quản lý khi không có token | Request không xác thực bị từ chối. |
| 10 | URL tải firmware có chữ ký hợp lệ | Token và chữ ký hợp lệ được xác minh. |
| 11 | Từ chối URL tải sai chữ ký | Chữ ký không hợp lệ bị từ chối. |
| 12 | Từ chối URL tải hết hạn | Token hết hạn bị từ chối. |

**Lưu ý về phạm vi test:** nội dung `tests/integration/ota.test.js` hiện có 12 test case. Các test này bao phủ API đăng ký/phát hành/thu hồi firmware, phân quyền cơ bản và xác minh URL tải. Chúng không chứng minh thiết bị ESP32 đã tải/cài firmware, cũng không chứng minh quy trình reboot/rollback trên phần cứng.

Tài liệu này ghi nhận sự tồn tại của 12 test case trong source; trạng thái PASS cần căn cứ vào kết quả chạy test thực tế tại môi trường của nhóm. Không tự suy ra kết quả PASS chỉ từ việc test case tồn tại.

---

## 10. Hạn chế hiện tại

1. **Chưa có firmware OTA ESP32 được xác nhận:** source Backend có gửi lệnh OTA và nhận status, nhưng chưa có bằng chứng source firmware thiết bị thực hiện quy trình OTA hoàn chỉnh.
2. **Chưa xác minh cài đặt trên OTA partition:** chưa có kết quả chứng minh firmware mới được ghi vào phân vùng OTA và boot partition được chuyển đúng.
3. **Chưa xác minh chữ ký ở phía thiết bị:** Backend tạo chữ ký Ed25519 cho SHA-256, nhưng chưa có bằng chứng firmware ESP32 xác minh chữ ký bằng public key tương ứng.
4. **Chưa có kiểm thử tải và cài firmware qua HTTPS trên ESP32 thật:** endpoint download có triển khai, nhưng chưa xác nhận thiết bị thật tải file thành công qua mạng triển khai.
5. **Chưa kiểm thử reboot và xác nhận firmware sau reboot:** trạng thái `REBOOTING`/`SUCCESS` hiện được Backend tiếp nhận theo MQTT contract; chưa chứng minh hành vi phần cứng.
6. **Chưa kiểm thử rollback vật lý:** Backend có trạng thái `ROLLED_BACK` và kiểm tra phiên bản quay về, nhưng chưa có bằng chứng bootloader/firmware thực hiện rollback.
7. **Storage hiện là local filesystem:** `LocalFirmwareStorage` lưu file trên thư mục cục bộ. Chưa có bằng chứng triển khai object storage hoặc cơ chế chia sẻ file giữa nhiều Backend instance.
8. **URL download có thời hạn ngắn:** mặc định 300 giây. Cần kiểm tra với tốc độ mạng, kích thước firmware và khả năng retry thực tế của thiết bị.
9. **Timeout job là cấu hình Backend:** mặc định 900 giây; cần đánh giá lại theo kích thước file, tốc độ tải và thời gian cài đặt thực tế.
10. **Chưa có bằng chứng kiểm thử bảo mật toàn bộ OTA:** cần kiểm tra key provisioning, bảo vệ private key, lưu public key trên thiết bị, chống downgrade, firmware bị thay thế, mất điện khi ghi flash và nguồn firmware không đáng tin cậy.
11. **Chưa nghiệm thu TLS cho thiết bị:** hướng dẫn vận hành nêu cổng host mặc định chỉ bind loopback và mẫu Mosquitto TLS chưa được nghiệm thu tại môi trường đích. Thiết bị thật cần cấu hình HTTPS/MQTT TLS và xác minh CA/hostname phù hợp.
12. **Chưa có giao diện quản lý OTA được xác nhận:** các route Backend tồn tại, nhưng README hiện ghi frontend chưa nghiệm thu.

---

## 11. Công việc cần thực hiện để hoàn thiện ADV-05

### 11.1. Firmware ESP32

- Xây dựng hoặc tích hợp OTA handler cho ESP32.
- Tiếp nhận và kiểm tra lệnh OTA theo MQTT contract.
- Kiểm tra `job_id`, `firmware_id`, `device_id`, `room_id`, `session_id` và `expires_at`.
- Tải firmware từ HTTPS download URL.
- Kiểm tra kích thước file và SHA-256.
- Xác minh chữ ký Ed25519 bằng public key tương ứng với private key Backend.
- Ghi firmware bằng cơ chế OTA partition phù hợp với board ESP32.
- Chỉ chuyển boot partition sau khi kiểm tra file thành công.
- Reboot và kiểm tra firmware mới khởi động.
- Gửi các trạng thái OTA qua topic `ota/status`.
- Có cơ chế rollback khi firmware mới không hoạt động theo tiêu chí đã xác định.
- Chống xử lý lặp cùng OTA Job và xử lý trường hợp thiết bị mất mạng giữa quá trình cập nhật.

### 11.2. Backend và hợp đồng giao tiếp

- Chốt schema payload `ota/command` và `ota/status` giữa Backend và firmware.
- Xác nhận cách thiết bị xác thực chữ ký Ed25519 và định dạng public key.
- Xác định quy tắc tiến độ và thứ tự trạng thái OTA.
- Kiểm tra trường hợp thiết bị reboot làm thay đổi MQTT session trong khi job đang ở `REBOOTING`.
- Xác định timeout theo kích thước firmware và điều kiện mạng.
- Kiểm thử retry download, mất ACK/status và thiết bị reconnect.
- Xác định chính sách firmware version: nâng cấp, cài lại cùng phiên bản và chống downgrade.
- Xem xét storage phù hợp khi triển khai nhiều Backend instance.

### 11.3. Kiểm thử đầu cuối trên phần cứng

- Biên dịch firmware OTA cho đúng board ESP32.
- Cập nhật thử trên Sensor Node thật.
- Cập nhật thử trên Control Node thật nếu phần cứng/firmware hỗ trợ.
- Kiểm tra file đúng, file sai hash và chữ ký sai.
- Ngắt Wi-Fi/MQTT trong từng giai đoạn tải/cài đặt.
- Mất nguồn khi tải hoặc ghi firmware.
- Kiểm tra reboot sau cập nhật.
- Kiểm tra firmware mới hoạt động và Backend cập nhật đúng `firmware_version`.
- Cố tình tạo lỗi boot để kiểm tra rollback.
- Kiểm tra URL hết hạn và tải lại theo quy trình được thiết kế.
- Kiểm tra job timeout, firmware bị thu hồi và thiết bị bị revoke trong quá trình OTA.

---

## 12. Kết luận

ADV-05 hiện đã có nền tảng Backend cho chức năng cập nhật firmware từ xa. Backend hỗ trợ đăng ký và quản lý bản firmware, tính SHA-256, ký hash bằng Ed25519, phát hành/thu hồi firmware, lưu file, tạo URL tải có chữ ký và thời hạn, tạo OTA Job, gửi lệnh qua MQTT bằng outbox, nhận trạng thái OTA và quản lý tiến độ/kết quả trong PostgreSQL.

Cơ chế kiểm tra thiết bị, phòng học, heartbeat, session MQTT và credential version được sử dụng trước khi tạo/gửi OTA Job. Backend cũng có kiểm tra chuyển trạng thái, timeout, audit và sự kiện nội bộ.

Tuy nhiên, phần Backend không đồng nghĩa với việc chức năng OTA đã hoàn chỉnh trên thiết bị. Chưa có bằng chứng xác nhận firmware ESP32 tải file, xác minh chữ ký, ghi OTA partition, reboot và rollback thành công trên phần cứng thật. Bộ test hiện có 12 test case tập trung vào API và chữ ký URL; cần căn cứ kết quả chạy thực tế để xác nhận PASS.

**Đánh giá trạng thái:** Phần Backend ADV-05 đã có mã nguồn tích hợp trong repository. Phần firmware OTA trên ESP32 và kiểm thử đầu cuối phần cứng vẫn là các hạng mục chưa được xác nhận; do đó chưa nên đánh dấu ADV-05 hoàn tất toàn hệ thống.
