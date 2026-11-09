# HƯỚNG DẪN CHẠY, KIỂM THỬ VÀ ĐÁNH GIÁ 5 CHỨC NĂNG NÂNG CAO (ADV-01 → ADV-05)

**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Phạm vi:** ADV-01, ADV-02, ADV-03, ADV-04, ADV-05  
**Đối tượng sử dụng:** Thành viên phát triển, tích hợp và kiểm thử  
**Loại tài liệu:** Hướng dẫn thực hành độc lập  
**Phiên bản:** 2.0  
**Ngày biên soạn:** 09/11/2026

---

# Mục lục

1. [Mục đích và nguyên tắc sử dụng](#1-mục-đích-và-nguyên-tắc-sử-dụng)
2. [Tổng quan 5 chức năng](#2-tổng-quan-5-chức-năng)
3. [Chuẩn bị môi trường](#3-chuẩn-bị-môi-trường)
4. [Khởi chạy hệ thống và kiểm tra nền tảng](#4-khởi-chạy-hệ-thống-và-kiểm-tra-nền-tảng)
5. [ADV-01 — Digital Twin / Device Shadow](#5-adv-01--digital-twin--device-shadow)
6. [ADV-02 — Offline Data Buffering & Synchronization](#6-adv-02--offline-data-buffering--synchronization)
7. [ADV-03 — Monitoring và Logging tập trung](#7-adv-03--monitoring-và-logging-tập-trung)
8. [ADV-04 — Phát hiện dữ liệu môi trường bất thường](#8-adv-04--phát-hiện-dữ-liệu-môi-trường-bất-thường)
9. [ADV-05 — Cập nhật firmware từ xa (OTA)](#9-adv-05--cập-nhật-firmware-từ-xa-ota)
10. [Kiểm thử phối hợp 5 chức năng](#10-kiểm-thử-phối-hợp-5-chức-năng)
11. [Đánh giá và ghi nhận kết quả](#11-đánh-giá-và-ghi-nhận-kết-quả)
12. [Bảng lệnh kiểm thử tổng hợp](#12-bảng-lệnh-kiểm-thử-tổng-hợp)
13. [Xử lý lỗi thường gặp](#13-xử-lý-lỗi-thường-gặp)
14. [Checklist nghiệm thu](#14-checklist-nghiệm-thu)
15. [Kết luận](#15-kết-luận)

---

## 1. Mục đích và nguyên tắc sử dụng

Tài liệu hướng dẫn cách chuẩn bị môi trường, khởi chạy các dịch vụ cần thiết, thực hiện nghiệp vụ, chạy test và đánh giá kết quả cho năm chức năng nâng cao:

| Mã | Tên chức năng |
|---|---|
| ADV-01 | Digital Twin / Device Shadow |
| ADV-02 | Offline Data Buffering & Synchronization |
| ADV-03 | Monitoring và Logging tập trung |
| ADV-04 | Phát hiện dữ liệu môi trường bất thường |
| ADV-05 | Cập nhật firmware từ xa (OTA) |

Hướng dẫn được tổng hợp dựa trên năm tài liệu ADV trong repository. Các lệnh chạy được đối chiếu với `package.json` và cấu trúc test hiện có.

### 1.1. Phân biệt các mức hoàn thành

Không dùng chung một kết luận “đã hoàn thành” cho mọi loại kiểm thử.

| Mức | Có thể kết luận khi nào? |
|---|---|
| Đã có mã nguồn | Repository có module/service/firmware tương ứng. |
| Đã chạy unit test | Đã chạy đúng lệnh test và có output PASS. |
| Đã chạy integration test | Đã chạy test với các dependency được yêu cầu, ví dụ PostgreSQL/MQTT test broker. |
| Đã kiểm thử trên phần cứng | Đã nạp firmware lên thiết bị thật, thực hiện tình huống kiểm thử và lưu bằng chứng. |
| Đã nghiệm thu chức năng | Các tiêu chí của phạm vi nghiệm thu đã đạt; các giới hạn còn lại được nêu rõ. |

**Không suy luận từ mức thấp lên mức cao.** Unit test PASS không đồng nghĩa integration test PASS; firmware build PASS không đồng nghĩa firmware chạy đúng trên ESP32.

### 1.2. Nguyên tắc an toàn

- Chạy lệnh tại thư mục gốc repository, nơi có `package.json`.
- Không chạy test có thao tác ghi/xóa dữ liệu trên database production hoặc database chứa dữ liệu thật.
- Integration test phải dùng database test theo cấu hình repository; README quy định tên database test kết thúc bằng `_test`.
- Không xóa Docker volume nếu cần giữ dữ liệu.
- Không ghi mật khẩu, token, MQTT credential, private key hoặc nội dung `.env` vào tài liệu, ảnh chụp hay log chia sẻ.
- Không tự thay đổi migration đã áp dụng. Nếu cần thay schema, sử dụng migration mới theo quy tắc repository.
- Nếu lệnh không tồn tại trong `npm run`, kiểm tra đúng branch và `package.json` trước khi thực hiện; không tự đặt tên script.
- Những bước cần ESP32 thật chỉ được thực hiện khi có board, firmware phù hợp, nguồn cấp và kết nối mạng an toàn.

---

## 2. Tổng quan 5 chức năng

| Chức năng | Thành phần chính | Kết quả cần quan sát |
|---|---|---|
| ADV-01 | Commands, Device Shadow, PostgreSQL, MQTT, Control Node | Desired/Reported State, version, `in_sync`, `differences`, command status |
| ADV-02 | Sensor Node, LittleFS, MQTT, Telemetry Ingestion, PostgreSQL | Hàng đợi offline, gửi bù, ACK `STORED`, chống trùng |
| ADV-03 | LoggingService, MonitoringService, repository, MQTT runtime | Log JSON, che dữ liệu nhạy cảm, component status, heartbeat, counter, snapshot |
| ADV-04 | AnomalyDetectionService, Consumer, PostgreSQL | Baseline, `WARMING_UP`, `NORMAL`, `ANOMALY`, kết quả phân tích |
| ADV-05 | OTA Service, PostgreSQL, firmware storage, MQTT, ESP32 | Firmware release, OTA Job, tiến độ, kết quả cập nhật |

### 2.1. Quan hệ nghiệp vụ

Một luồng phối hợp có thể diễn ra như sau:

1. Sensor Node thu thập dữ liệu môi trường.
2. Khi mất mạng, ADV-02 lưu telemetry vào LittleFS; khi kết nối trở lại, thiết bị gửi bù các bản ghi chưa được xác nhận.
3. Backend tiếp nhận và lưu telemetry. Dữ liệu được lưu có thể được sử dụng bởi ADV-03 để thống kê/giám sát và ADV-04 để phân tích bất thường.
4. Với Control Node, ADV-01 quản lý trạng thái mong muốn và trạng thái thực tế khi điều khiển đèn/quạt.
5. ADV-05 quản lý firmware và điều phối yêu cầu cập nhật từ xa cho thiết bị tương thích.

Đây là mối quan hệ nghiệp vụ. Không mặc định rằng mọi điểm tích hợp đầu cuối đã được nghiệm thu.

---

## 3. Chuẩn bị môi trường

### 3.1. Công cụ cần có

| Công cụ | Mục đích |
|---|---|
| Node.js >= 20, khuyến nghị 24 | Chạy Backend và test |
| npm | Cài dependencies và chạy scripts |
| Docker Desktop / Docker Compose | Khởi chạy PostgreSQL và Mosquitto theo cấu hình repository |
| PostgreSQL | Lưu dữ liệu nghiệp vụ |
| Mosquitto MQTT | Giao tiếp giữa Backend và thiết bị |
| Arduino CLI, ESP32 Arduino Core | Build firmware theo workflow |
| ESP32 Sensor Node / Control Node | Kiểm thử phần cứng thực tế |
| HTTP client | Gọi API khi thực hiện nghiệp vụ |

README cho biết CI kiểm tra Node.js 22 và 24. Không tự suy diễn phiên bản chính xác của PostgreSQL, Mosquitto hoặc board nếu cấu hình repository không chỉ định.

### 3.2. Cài đặt công cụ build firmware ESP32 (chỉ cần khi build/nạp firmware local)

Các bài unit test Backend không cần Arduino CLI. Chỉ cần cài thêm Arduino CLI, ESP32 Arduino Core và các thư viện dưới đây khi muốn tự build firmware Sensor Node/Control Node trên máy Windows.

**Bước 1 — Cài Arduino CLI**

Tải bộ cài Windows 64-bit từ trang chính thức:

- https://docs.arduino.cc/arduino-cli/installation/

Có thể chọn Windows MSI hoặc Windows ZIP. Sau khi cài đặt, mở terminal PowerShell mới và kiểm tra:

```powershell
arduino-cli version
```

Nếu PowerShell báo không nhận diện lệnh, kiểm tra thư mục cài đặt đã được thêm vào `PATH` hay chưa; đóng và mở lại terminal sau khi thay đổi `PATH`.

**Bước 2 — Cài ESP32 Arduino Core đúng phiên bản CI**

Workflow `.github/workflows/firmware.yml` hiện dùng ESP32 Arduino Core `3.2.1` và FQBN `esp32:esp32:esp32`.

```powershell
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json

arduino-cli core install esp32:esp32@3.2.1 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

Kiểm tra:

```powershell
arduino-cli core list
```

**Bước 3 — Cài thư viện firmware theo workflow**

```powershell
arduino-cli lib install "ArduinoJson@6.21.5"
arduino-cli lib install "PubSubClient@2.8"
arduino-cli lib install "DHT sensor library@1.4.6"
arduino-cli lib install "Adafruit Unified Sensor@1.1.15"
arduino-cli lib install "BH1750@1.3.0"
arduino-cli lib install "Adafruit GFX Library@1.11.11"
arduino-cli lib install "Adafruit SSD1306@2.5.13"
```

**Bước 4 — Chuẩn bị cấu hình firmware**

Mỗi sketch có file mẫu riêng:

- `firmware/sensor_node/Config.h.example`
- `firmware/control_node/Config.h.example`

Tạo `Config.h` tương ứng từ file mẫu, sau đó điền Wi-Fi SSID/password, MQTT host/port, device ID, room ID và MQTT credential được cấp cho thiết bị.

Ví dụ PowerShell cho Sensor Node:

```powershell
Copy-Item firmware/sensor_node/Config.h.example firmware/sensor_node/Config.h
```

Ví dụ cho Control Node:

```powershell
Copy-Item firmware/control_node/Config.h.example firmware/control_node/Config.h
```

Không commit `Config.h` nếu có thông tin bí mật. Không sử dụng `YOUR_WIFI_PASSWORD`, `YOUR_DEVICE_SECRET` hoặc MQTT host mẫu như cấu hình chạy thật.

**Lưu ý riêng về OTA:** Trong hai file `Config.h.example`, `OTA_ENABLED` mặc định là `0`. Workflow CI tạo cấu hình tạm, bật OTA compile path và thêm public key/chứng chỉ giả chỉ để kiểm tra biên dịch. Không sao chép public key hoặc `OTA_ROOT_CA_CERT` giả của CI vào cấu hình thiết bị thật. Muốn chạy OTA thật phải dùng public key tương ứng với khóa ký firmware và CA certificate đúng cho HTTPS server.

**Bước 5 — Build firmware**

Build Sensor Node:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 --warnings all firmware/sensor_node
```

Build Control Node:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 --warnings all firmware/control_node
```

Nếu chỉ muốn build thông thường, giữ cấu hình phù hợp với firmware đang triển khai. Nếu cần kiểm tra nhánh biên dịch OTA, phải cấu hình `OTA_ENABLED` và các thông tin bảo mật hợp lệ trước khi build. Build thành công không chứng minh OTA hoạt động trên phần cứng.

**Bước 6 — Nhận diện board và cổng serial trước khi upload**

Kết nối ESP32 qua USB rồi chạy:

```powershell
arduino-cli board list
```

Chỉ thực hiện upload khi đã xác định đúng cổng serial và board. Workflow CI hiện chỉ compile, không upload firmware lên thiết bị.

Tham khảo cài đặt và lệnh Arduino CLI trong tài liệu chính thức: https://docs.arduino.cc/arduino-cli/installation/ và https://docs.arduino.cc/arduino-cli/getting-started/.

### 3.3. Kiểm tra thư mục gốc

Mở PowerShell tại thư mục repository và chạy:

```powershell
Get-Location
Test-Path .\package.json
npm run
```

`Test-Path` cần trả về `True`. Lệnh `npm run` liệt kê các scripts thực sự có trong `package.json`.

### 3.4. Cài dependencies

Nếu repository đã có `package-lock.json`, cài dependencies bằng:

```powershell
npm ci
```

Không chạy `npm install` chỉ để thử nếu mục tiêu là giữ nguyên dependency lockfile.

### 3.5. Tạo cấu hình local lần đầu

Nếu chưa có `.env` và `.env.test`, README hướng dẫn:

```powershell
npm run setup:local
```

Lệnh này tạo cấu hình local với mật khẩu ngẫu nhiên và từ chối ghi đè file cấu hình đã tồn tại.

**Nếu đã có `.env` hoặc `.env.test`:**
- Không chạy lại `setup:local` để thay mật khẩu.
- Đối chiếu `.env.example` và `.env.test.example` để bổ sung biến còn thiếu.
- Giữ ổn định secret của môi trường hiện có.
- Không chia sẻ nội dung file cấu hình có secret.

### 3.6. Khởi chạy PostgreSQL và MQTT cho môi trường test

Theo README, các service test được khởi chạy bằng:

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test
```

Repository quy định:
- PostgreSQL ứng dụng: `localhost:5433`.
- PostgreSQL test: `localhost:5434`.
- MQTT ứng dụng: `localhost:1884`.
- MQTT test: `localhost:1885`.

Các integration test phải dùng biến `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL` và cấu hình MQTT test tương ứng. Không tự đổi các URL này sang database ứng dụng.

### 3.7. Kiểm tra service

Có thể xem trạng thái container:

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test ps
```

Chỉ tiếp tục các bài integration test cần dependency khi database và broker test đã ở trạng thái hoạt động.

---

## 4. Khởi chạy hệ thống và kiểm tra nền tảng

### 4.1. Áp dụng migration

Từ thư mục gốc:

```powershell
npm run db:migrate
```

Lệnh này dùng cấu hình `.env` hiện tại. Chỉ chạy khi đã xác định đúng database đích. Migration ADV có liên quan:

| Chức năng | Migration |
|---|---|
| ADV-01 | `008_commands_shadow.sql` |
| ADV-04 | `016_anomaly_detection.sql` |
| ADV-05 | `017_ota_management.sql` |

ADV-02 sử dụng các bảng telemetry đã có trong backend; ADV-03 sử dụng repository cho monitoring và dữ liệu thiết bị. Không tự tạo migration mới chỉ để chạy test.

### 4.2. Seed dữ liệu

Nếu cần dữ liệu ban đầu cho môi trường phát triển:

```powershell
npm run db:seed
```

Seed không đặt lại mật khẩu của người dùng đã tồn tại. Tài khoản Admin được lấy từ `ADMIN_USERNAME` và `ADMIN_PASSWORD` trong `.env`.

### 4.3. Bootstrap MQTT

Khởi tạo broker ứng dụng:

```powershell
npm run mqtt:bootstrap
```

Khởi tạo broker test:

```powershell
npm run mqtt:bootstrap:test
```

Chạy bootstrap phù hợp với broker mà test hoặc ứng dụng sẽ sử dụng. Không dùng credential của broker ứng dụng để chạy integration test.

### 4.4. Chạy Backend

Nếu chạy Backend trực tiếp bằng Node.js:

```powershell
npm start
```

Hoặc chế độ tự reload khi phát triển:

```powershell
npm run dev
```

README mô tả Backend mặc định tại:

```text
http://127.0.0.1:3000
```

Kiểm tra:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3000/ready
```

- `/health`: kiểm tra ứng dụng đang hoạt động.
- `/ready`: kiểm tra migration, PostgreSQL, MQTT subscription và realtime listener; trả 503 nếu chưa sẵn sàng.

Nếu đang chạy Backend trong Docker trên cùng cổng/MQTT client ID, dừng service backend Docker trước khi chạy `npm start` để tránh xung đột.

### 4.5. Chạy Backend bằng Docker (phương án thay thế)

Theo README:

```powershell
npm ci
npm run setup:local
docker compose --env-file .env -f deployment/compose.yml --profile app up -d --build --wait backend
npm run smoke
```

Bỏ qua `setup:local` nếu cấu hình `.env` đã tồn tại. Không chạy đồng thời Backend Docker và Backend Node.js trên cùng cổng/client ID.

---

## 5. ADV-01 — Digital Twin / Device Shadow

### 5.1. Chức năng cần kiểm tra

ADV-01 duy trì hai trạng thái của Control Node:

- **Desired State:** trạng thái hệ thống yêu cầu.
- **Reported State:** trạng thái thiết bị thực tế báo về.

Các cơ cấu chấp hành được mô tả là:
- Đèn `light`: `ON`, `OFF`.
- Quạt `fan`: `ON`, `OFF`.

Khi chưa nhận trạng thái thực tế hợp lệ, Reported State có thể là `UNKNOWN`.

**Nguyên tắc đánh giá:** Tạo lệnh chỉ cập nhật Desired State. Không được coi thiết bị đã thực hiện thành công cho tới khi Backend nhận phản hồi hợp lệ.

### 5.2. Source code

```text
backend/src/modules/
├── device-shadow/
│   ├── device-shadow.errors.js
│   ├── device-shadow.mqtt.js
│   ├── device-shadow.repository.memory.js
│   ├── device-shadow.repository.pg.js
│   └── device-shadow.service.js
└── commands/
    ├── command-schemas.js
    ├── command-state.js
    ├── commands.routes.js
    └── commands.service.js

database/migrations/008_commands_shadow.sql
tests/device-shadow.test.js
tests/integration/commands.test.js
```

### 5.3. Chuẩn bị dữ liệu

Cần có:
- Một phòng học đang `ACTIVE`.
- Một Control Node đã đăng ký và đủ điều kiện điều khiển.
- Credential thiết bị đã đồng bộ với broker.
- Thiết bị đang online và có heartbeat/session hợp lệ nếu kiểm thử MQTT thật.
- Cơ cấu chấp hành `light` và/hoặc `fan`.

Khi Control Node được khởi tạo theo tài liệu ADV-01:
- Desired State mặc định: `light = OFF`, `fan = OFF`.
- Reported State ban đầu: `light = UNKNOWN`, `fan = UNKNOWN`.
- Desired Version: `1`.
- Reported Version: `0`.

### 5.4. Quy trình thực hiện nghiệp vụ

1. Đăng nhập bằng tài khoản có quyền phù hợp.
2. Truy vấn Device Shadow của Control Node.
3. Ghi lại Desired State, Reported State, version và trạng thái đồng bộ ban đầu.
4. Tạo lệnh điều khiển bật đèn hoặc quạt.
5. Kiểm tra command được tạo và Desired State/version thay đổi.
6. Kiểm tra Reported State chưa đổi chỉ vì lệnh được publish.
7. Nếu có thiết bị thật, xác nhận Control Node nhận lệnh MQTT và thực thi cơ cấu chấp hành.
8. Cho thiết bị gửi ACK và Reported State đúng schema.
9. Truy vấn lại Shadow và lịch sử command.
10. Đối chiếu trạng thái thực tế với trạng thái mong muốn.

API theo tài liệu ADV-01 (đường dẫn module; prefix đầy đủ phụ thuộc cách mount router trong Backend):

| Method | Đường dẫn | Mục đích |
|---|---|---|
| `GET` | `/devices/:id/shadow` | Truy vấn Shadow |
| `POST` | `/devices/:id/commands` | Tạo command |
| `GET` | `/devices/:id/commands` | Truy vấn lịch sử command |

Ví dụ body tạo command theo tài liệu:

```json
{
  "desired_state": {
    "fan": "ON"
  }
}
```

Tài liệu ADV-01 nêu thêm các trường có thể có như `timeout_seconds`; cần đọc schema trong `command-schemas.js` trước khi gửi request, không tự thêm field không được schema chấp nhận.

### 5.5. Chạy unit test ADV-01

```powershell
npm run test:device-shadow
```

Script thực thi:

```powershell
node --test tests/device-shadow.test.js
```

11 trường hợp đã được tài liệu ADV-01 ghi nhận:
1. Tạo Device Shadow với trạng thái ban đầu.
2. Phát hiện chênh lệch Desired/Reported State.
3. Xác định `UNKNOWN` là chưa đồng bộ.
4. Lấy thông tin command gần nhất.
5. Báo lỗi khi không tìm thấy Shadow.
6. Chấp nhận trạng thái điều khiển hợp lệ.
7. Từ chối trạng thái điều khiển không hợp lệ.
8. Từ chối Desired State rỗng.
9. Từ chối Desired State không phải object.
10. Tạo MQTT command topic hợp lệ.
11. Từ chối topic chứa ký tự không hợp lệ.

**Kết quả đã ghi nhận trong tài liệu:** 11/11 PASS, nguồn là ảnh kết quả local do nhóm cung cấp ngày 04/11/2026.

### 5.6. Kiểm thử integration ADV-01

Có test file:

```text
tests/integration/commands.test.js
```

Chạy riêng:

```powershell
node --test tests/integration/commands.test.js
```

Hoặc chạy toàn bộ integration test:

```powershell
npm run test:integration
```

Các tình huống integration được mô tả trong tài liệu ADV-01 gồm MQTT command, idempotency, phân quyền, ACK sai thứ tự, timeout, ACK đến muộn, lỗi publish, lỗi transaction, thiết bị kết nối lại và ACK không hợp lệ.

Tài liệu ADV-01 chưa cung cấp kết quả chạy integration độc lập cho file `commands.test.js`. Vì vậy, phải chạy lại và ghi output thực tế; không ghi 11/11 unit test thành kết quả integration.

### 5.7. Đánh giá kết quả ADV-01

| Kiểm tra | Kết quả mong đợi |
|---|---|
| Shadow mới được khởi tạo | Desired có giá trị mặc định; Reported có thể là `UNKNOWN` |
| Tạo command | Desired State và version thay đổi |
| Chưa có ACK hợp lệ | Reported State không tự đổi |
| ACK hợp lệ, đúng session/version | Command và Reported State được cập nhật |
| Desired khớp Reported | `in_sync = true`, `differences` rỗng |
| Desired khác Reported | `in_sync = false`, `differences` chỉ ra thuộc tính lệch |
| ACK sai session/version | Bị từ chối, không ghi đè trạng thái hợp lệ |
| ACK lặp/đến muộn | Không làm thay đổi kết quả cuối cùng sai quy tắc |

**Mức đã có bằng chứng:** 11/11 unit test PASS. Kiểm thử đầu cuối với ESP32 và Mosquitto cần xác nhận riêng.

---

## 6. ADV-02 — Offline Data Buffering & Synchronization

### 6.1. Chức năng cần kiểm tra

ADV-02 hạn chế mất telemetry khi Sensor Node mất Wi-Fi hoặc MQTT. Thiết bị ghi bản ghi vào LittleFS trước khi gửi. Khi kết nối khôi phục, thiết bị gửi lại bản ghi chưa được Backend xác nhận.

Backend chỉ gửi ACK ứng dụng `STORED` sau khi transaction PostgreSQL hoàn tất. Thiết bị chỉ xóa bản ghi khỏi hàng đợi khi ACK đúng định dạng, đúng ID và đúng trạng thái.

Thiết kế sử dụng at-least-once delivery. MQTT QoS 1 không thay thế ACK nghiệp vụ.

### 6.2. Source code

```text
firmware/sensor_node/
├── OfflineQueue.cpp
├── OfflineQueue.h
├── MqttSyncManager.cpp
├── MqttSyncManager.h
├── TelemetryMessage.cpp
├── TelemetryMessage.h
├── SensorDrivers.cpp
├── SensorDrivers.h
└── sensor_node.ino

backend/src/modules/telemetry-ingestion/
├── telemetry-pipeline.js
├── telemetry-ingestion.service.js
├── telemetry-ingestion.repository.pg.js
└── telemetry-normalizer.js

tests/integration/
├── telemetry.test.js
└── phase3-firmware-sensor.test.js
```

`OfflineQueue` và `MqttSyncManager` hiện được đặt trong `firmware/sensor_node/`. Không nhầm với các module dùng chung trong `firmware/common/`.

### 6.3. Chuẩn bị môi trường

- PostgreSQL test và MQTT test broker đang hoạt động.
- Cấu hình `.env.test` trỏ đúng database test và MQTT test.
- Sensor Node firmware dùng cấu hình tương ứng với broker và thiết bị thử nghiệm.
- Nếu thử trên phần cứng, cần ESP32 Sensor Node và LittleFS được mount thành công.

Khởi chạy dependency test theo README:

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test
```

### 6.4. Kiểm tra luồng telemetry

1. Sensor Node lấy mẫu cảm biến.
2. Kiểm tra mỗi bản ghi có ID duy nhất.
3. Xác nhận bản ghi được đưa vào hàng đợi LittleFS trước khi publish.
4. Publish telemetry lên topic:

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry
```

5. Backend kiểm tra topic và định danh trong payload.
6. Backend kiểm tra schema, giá trị cảm biến, thiết bị, phòng và credential.
7. Backend ghi `sensor_data`, `telemetry_latest` và event trong transaction.
8. Sau commit, Backend gửi ACK lên:

```text
smartclassroom/room/{roomCode}/device/{deviceId}/telemetry/ack
```

9. Thiết bị chỉ xóa bản ghi nếu ACK có ID khớp và `status = STORED`.

### 6.5. Payload cần phân biệt

**Payload hiện hành** dùng các trường `msg_id`, `device_id`, `room_id`, `timestamp` (Unix milliseconds) và object `data`.

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

**Payload legacy** dùng `eventId`, `deviceId`, `roomCode`, timestamp ISO và các trường như `temperatureC`, `humidityPercent`, `illuminanceLux`. Backend vẫn hỗ trợ normalizer cho payload legacy. Không tự đổi format khi firmware/backend đang kiểm thử một hợp đồng cụ thể.

ACK hiện hành có các trường `msg_id`, `device_id`, `room_id`, `status`, `duplicate`, `timestamp`; timestamp là Unix milliseconds. ACK legacy dùng `eventId` và timestamp ISO. Cả hai phải có `status = STORED` và định danh trùng bản ghi chờ.

### 6.6. Chạy test Backend ADV-02

Các script liên quan trong `package.json`:

```powershell
npm run test:telemetry-ingestion
npm run test:integration
npm run test:firmware-phase3
```

Ý nghĩa:
- `test:telemetry-ingestion`: chạy `tests/telemetry-ingestion.test.js`.
- `test:integration`: chạy toàn bộ `tests/integration/*.test.js`.
- `test:firmware-phase3`: chạy `tests/integration/phase3-firmware-sensor.test.js`.

Nếu muốn khoanh vùng riêng integration telemetry:

```powershell
node --test tests/integration/telemetry.test.js
```

### 6.7. Kiểm thử mất mạng trên ESP32 thật

Đây là bài kiểm thử phần cứng, không được thay thế bằng test Backend:

1. Nạp firmware Sensor Node có OfflineQueue/MqttSyncManager.
2. Cấp nguồn và xác nhận Wi-Fi/MQTT kết nối.
3. Ghi nhận số bản tin telemetry đang được gửi bình thường.
4. Ngắt Wi-Fi hoặc MQTT.
5. Tiếp tục để Sensor Node thu thập dữ liệu.
6. Kiểm tra hàng đợi LittleFS tăng và bản ghi vẫn tồn tại khi mất mạng.
7. Khởi động lại ESP32 khi còn bản ghi chờ.
8. Xác nhận hàng đợi được phục hồi sau reboot.
9. Khôi phục Wi-Fi/MQTT.
10. Quan sát thiết bị gửi bù bản ghi chưa được xác nhận.
11. Làm mất ACK hoặc gửi ACK sai ID/trạng thái trong môi trường kiểm thử có kiểm soát.
12. Xác nhận thiết bị không xóa bản ghi khi ACK không hợp lệ.
13. Khi nhận ACK `STORED` đúng ID, xác nhận bản ghi tương ứng được xóa.
14. Đối chiếu database để bảo đảm không sinh bản ghi trùng.

Không thực hiện ngắt nguồn đột ngột trên thiết bị đang dùng cho mục đích khác hoặc đang lưu dữ liệu quan trọng.

### 6.8. Đánh giá kết quả ADV-02

| Tình huống | Điều kiện đạt |
|---|---|
| Mất Wi-Fi/MQTT | Telemetry mới vẫn được lưu trong LittleFS |
| Reboot khi còn dữ liệu chờ | Hàng đợi được phục hồi |
| Kết nối trở lại | Các bản ghi chưa xác nhận được gửi lại |
| ACK mất | Bản ghi vẫn còn trong hàng đợi và có thể retry |
| ACK sai ID/trạng thái | Không xóa bản ghi |
| ACK `STORED` đúng ID | Chỉ bản ghi tương ứng được xác nhận xóa |
| Gửi lặp cùng ID | Backend không tạo bản ghi telemetry trùng |
| Backfill cũ hơn latest | Lưu lịch sử nhưng không ghi đè latest |

**Kết quả đã ghi nhận trong tài liệu ADV-02:** Backend Checks trên commit `abab893` đạt 106/106 tests PASS; Firmware Build trên commit `6421454` build thành công Sensor Node và Control Node. Chưa có bằng chứng kiểm thử mất mạng, phục hồi LittleFS và gửi bù trên ESP32 thật.

---

## 7. ADV-03 — Monitoring và Logging tập trung

### 7.1. Chức năng cần kiểm tra

ADV-03 cung cấp:
- Logging theo `DEBUG`, `INFO`, `WARN`, `ERROR`.
- Log JSON gồm timestamp, level, service, message và metadata.
- Che một số trường nhạy cảm theo tên khóa.
- Console sink và Memory sink.
- Trạng thái component `UP`, `DEGRADED`, `DOWN`, `UNKNOWN`.
- Heartbeat online/offline.
- Counter sự kiện.
- PostgreSQL repository cho component/counter và đọc trạng thái thiết bị.
- Snapshot tổng hợp.

### 7.2. Source code và vai trò

Trong repository, xác định module Monitoring/Logging theo cấu trúc được mô tả trong tài liệu ADV-03. Các thành phần trọng tâm là `LoggingService`, `MonitoringService`, repository in-memory/PostgreSQL và hàm `bindMonitoring(runtime, monitoring)`.

`bindMonitoring()` đăng ký lắng nghe sự kiện `device-message` từ MQTT runtime để ghi nhận counter. Tuy nhiên, tài liệu ADV-03 lưu ý việc hàm này đã được đăng ký trong luồng khởi tạo thực tế cần xác nhận riêng.

### 7.3. Thực hiện kiểm tra Logging

1. Khởi tạo `LoggingService` với cấu hình sink phù hợp.
2. Ghi thử log ở bốn mức `DEBUG`, `INFO`, `WARN`, `ERROR`.
3. Kiểm tra output có timestamp, level, service, message và metadata.
4. Ghi log có metadata chứa các key nhạy cảm như `password`, `token`, `secret`, `authorization`, `apiKey`.
5. Kiểm tra giá trị nhạy cảm được che theo cơ chế hiện tại.
6. Thử level hoặc message không hợp lệ.
7. Kiểm tra logger từ chối dữ liệu không hợp lệ.

**Lưu ý:** Cơ chế che dữ liệu hiện dựa trên tên khóa. Không kết luận rằng mọi secret nằm trong message tự do đều được phát hiện.

### 7.4. Thực hiện kiểm tra Monitoring

1. Khởi tạo trạng thái component.
2. Cập nhật component sang `UP`, `DEGRADED`, `DOWN`, `UNKNOWN`.
3. Gửi heartbeat với timestamp hợp lệ.
4. Kiểm tra trạng thái online.
5. Để thời gian vượt ngưỡng offline mặc định 60 giây theo tài liệu ADV-03.
6. Kiểm tra trạng thái offline.
7. Ghi nhận các event và kiểm tra counter tăng tương ứng.
8. Gọi `getSnapshot()` và đối chiếu trạng thái component, heartbeat, counter và thông tin thiết bị.

Nếu kiểm tra bằng code/service trực tiếp, dùng đúng interface trong module hiện tại; tài liệu không xác nhận một HTTP API riêng cho snapshot ADV-03, vì vậy không tự đặt endpoint.

### 7.5. Chạy test ADV-03

```powershell
npm run test:monitoring-logging
```

Script chạy:

```powershell
node --test tests/monitoring-logging.test.js
```

Tài liệu ADV-03 ghi nhận 12 trường hợp:
1. Logger ghi log JSON có cấu trúc.
2. Logger che trường nhạy cảm.
3. Từ chối log level/message không hợp lệ.
4. Cập nhật trạng thái component.
5. Heartbeat tính online và chuyển offline khi quá ngưỡng.
6. Đếm sự kiện và ghi log tương ứng.
7. Từ chối heartbeat timestamp không hợp lệ.
8. Từ chối component status và amount không hợp lệ.
9. Không tăng counter khi log level không hợp lệ.
10. PostgreSQL repository lưu trạng thái component.
11. PostgreSQL repository đọc trạng thái thiết bị từ `devices`.
12. PostgreSQL repository tăng counter bằng upsert.

**Kết quả đã ghi nhận:** 12/12 PASS trong lần chạy local do nhóm cung cấp.

### 7.6. Đánh giá kết quả ADV-03

| Hạng mục | Điều kiện đạt |
|---|---|
| Logging | Log JSON có đủ trường và đúng level |
| Redaction | Các key nhạy cảm đã hỗ trợ được che |
| Validation | Level/message/timestamp/status/amount sai bị từ chối |
| Component | Trạng thái được cập nhật đúng |
| Heartbeat | Online/offline đúng ngưỡng cấu hình |
| Counter | Tăng đúng event, không tăng khi input bị từ chối |
| Snapshot | Dữ liệu tổng hợp khớp repository |
| PostgreSQL | Chỉ kết luận DB thật khi test trực tiếp trên PostgreSQL |

**Giới hạn đã nêu trong tài liệu:** test repository PostgreSQL đang dùng pool giả lập; chưa chứng minh truy vấn trên PostgreSQL thật. Việc đăng ký `bindMonitoring()` trong MQTT runtime, tích hợp heartbeat thực tế và dashboard frontend cũng chưa được xác nhận.

---

## 8. ADV-04 — Phát hiện dữ liệu môi trường bất thường

### 8.1. Chức năng cần kiểm tra

ADV-04 phân tích ba chỉ số:
- `temperatureC`
- `humidityPercent`
- `illuminanceLux`

Hệ thống tạo baseline riêng theo thiết bị và metric. Khi chưa đủ mẫu, kết quả là `WARMING_UP`. Khi đủ mẫu, service sử dụng Median, MAD và Robust Z-score để phân loại `NORMAL` hoặc `ANOMALY`.

Cấu hình mặc định trong tài liệu:
- `minSamples = 8`
- `windowSize = 30`
- `threshold = 3.5`

Đây là phương pháp thống kê robust, chưa phải mô hình machine learning được huấn luyện.

### 8.2. Source code và migration

```text
database/migrations/016_anomaly_detection.sql

backend/src/modules/anomaly-detection/
├── anomaly-detection.errors.js
├── anomaly-detection.repository.memory.js
├── anomaly-detection.repository.pg.js
├── anomaly-detection.service.js
└── anomaly-detection.consumer.js

tests/
├── anomaly-detection.test.js
└── anomaly-detection-consumer.test.js
```

`server.js` khởi tạo consumer và chạy job `anomaly-detection` định kỳ.

### 8.3. Chuẩn bị dữ liệu

Consumer chỉ xử lý dữ liệu đáp ứng điều kiện theo tài liệu:
- Thiết bị `ACTIVE`.
- Phòng học `ACTIVE`.
- Telemetry đủ điều kiện.
- Dữ liệu mới nhất, không phải backfill.
- Không clock skew.
- `data_id` khớp bản ghi mới nhất trong `telemetry_latest`.

Consumer đọc sự kiện `telemetry.stored`, lấy bản ghi `sensor_data`, sau đó gọi service. Việc lưu baseline, kết quả và delivery nằm trong transaction. Nếu xử lý lỗi trước commit, transaction rollback và sự kiện có thể được retry.

### 8.4. Thực hiện nghiệp vụ bằng dữ liệu

Để kiểm tra từng trạng thái, dùng dữ liệu có kiểm soát và cùng một thiết bị/metric:

1. Đảm bảo baseline của thiết bị/metric chưa đủ 8 mẫu.
2. Gửi các mẫu hợp lệ để baseline tích lũy.
3. Quan sát kết quả `WARMING_UP`.
4. Khi baseline đủ mẫu, gửi giá trị nằm gần vùng Median.
5. Quan sát kết quả `NORMAL`.
6. Gửi một giá trị lệch đáng kể so với baseline.
7. Quan sát kết quả `ANOMALY`, `score`, `median`, `mad`, `threshold` và `reason`.
8. Kiểm tra mẫu bất thường không được thêm vào baseline.
9. Gửi lại cùng `eventId`/`data_id` để kiểm tra chống trùng.
10. Thử dữ liệu backfill, clock skew, không mới nhất hoặc thiết bị/phòng không ACTIVE; xác nhận consumer bỏ qua và ghi delivery theo logic.

Với MAD bằng 0, tài liệu mô tả:
- Giá trị mới bằng Median: score 0, bình thường.
- Giá trị mới khác Median: bất thường với reason `DEVIATION_FROM_CONSTANT_BASELINE`, score `null`.

Không tự đặt một con số “bất thường” chung cho mọi thiết bị; kết quả phụ thuộc baseline thực tế và cấu hình.

### 8.5. Chạy test ADV-04

```powershell
npm run test:anomaly-detection
```

Script chạy các file:

```text
tests/anomaly-detection*.test.js
```

Chạy toàn bộ repository:

```powershell
npm test
```

Áp dụng migration:

```powershell
npm run db:migrate
```

Chỉ chạy migration sau khi xác định `.env` đang trỏ đúng database phát triển mong muốn.

### 8.6. Các trường hợp test đã ghi nhận

Tài liệu ADV-04 ghi nhận 16 test:
1. `WARMING_UP` khi chưa đủ mẫu.
2. Phát hiện nhiệt độ lệch baseline.
3. Giá trị bình thường không bị đánh dấu bất thường.
4. Không đưa điểm bất thường vào baseline.
5. Xử lý nhiều chỉ số trong telemetry.
6. Từ chối dữ liệu cảm biến không hợp lệ.
7. Không cập nhật baseline lần hai khi trùng `eventId`.
8. Reset baseline một chỉ số.
9. Từ chối reset metric không hỗ trợ.
10. Consumer xử lý telemetry hợp lệ và lưu baseline/kết quả/delivery.
11. Consumer bỏ qua telemetry không eligible.
12. Consumer bỏ qua backfill hoặc clock skew.
13. Consumer bỏ qua thiết bị/phòng không hoạt động.
14. Rollback và không đánh dấu delivery khi lưu kết quả thất bại.
15. Không xử lý lại event đã delivery.
16. Bỏ qua telemetry không còn là bản ghi mới nhất.

**Kết quả đã ghi nhận tại local:** ADV-04 16/16 PASS; toàn bộ repository 52/52 PASS. Migration `016_anomaly_detection.sql` được áp dụng với `applied: 1`.

### 8.7. Đánh giá kết quả ADV-04

| Tình huống | Kết quả mong đợi |
|---|---|
| Chưa đủ 8 mẫu | `WARMING_UP` |
| Đủ mẫu, điểm mới bình thường | `NORMAL` |
| Robust Z-score đạt/vượt ngưỡng | `ANOMALY` |
| Điểm bị phân loại bất thường | Không thêm vào baseline |
| Event trùng | Không phân tích/lưu lặp |
| Dữ liệu backfill/clock skew/không mới nhất | Consumer bỏ qua theo điều kiện |
| Lưu kết quả thất bại | Transaction rollback, delivery chưa được commit |

**Giới hạn:** Consumer test dùng mock PostgreSQL client; chưa phải kiểm thử PostgreSQL integration thật. Chưa có bằng chứng kiểm thử đầu cuối ESP32 → MQTT → telemetry ingestion → Consumer. Chưa có chỉ số precision/recall/false-positive trên dữ liệu thực.

---

## 9. ADV-05 — Cập nhật firmware từ xa (OTA)

### 9.1. Chức năng cần kiểm tra

ADV-05 hỗ trợ quản lý firmware, phát hành/thu hồi, tạo OTA Job, gửi lệnh MQTT, cung cấp firmware qua HTTPS và tiếp nhận trạng thái OTA.

Hai loại thiết bị:
- `SENSOR_NODE`
- `CONTROL_NODE`

Phần Backend và test tự động đã có; OTA end-to-end trên ESP32 thật chưa được xác nhận.

### 9.2. Source code và migration

```text
database/migrations/017_ota_management.sql

backend/src/modules/ota/
├── ota.service.js
├── ota.routes.js
├── ota.repository.pg.js
├── ota.storage.js
├── ota.download-signer.js
└── ota.download.routes.js

backend/src/mqtt/
├── bootstrap.js
├── bootstrap-cli.js
└── runtime.js

tests/integration/ota.test.js
```

### 9.3. Trạng thái dữ liệu

Firmware release:
- `DRAFT`
- `PUBLISHED`
- `REVOKED`

OTA Job:
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

Một thiết bị chỉ có tối đa một OTA Job đang hoạt động.

### 9.4. Quy trình đăng ký và phát hành firmware

1. Đăng ký firmware với version, device type, hardware target, file name và release notes.
2. Backend tính SHA-256, kích thước file và lưu file.
3. Firmware được tạo ở trạng thái `DRAFT`.
4. Khi publish, Backend đọc lại file.
5. Kiểm tra kích thước và SHA-256 khớp metadata.
6. Ký hash bằng Ed25519.
7. Chuyển firmware sang `PUBLISHED`.

Không sử dụng firmware rỗng hoặc metadata thiếu. Không publish lại firmware đã publish.

### 9.5. API Backend

| Method | Endpoint | Quyền | Chức năng |
|---|---|---|---|
| POST | `/api/v1/ota/firmware` | `ota:firmware:write` | Đăng ký firmware |
| GET | `/api/v1/ota/firmware` | `ota:firmware:read` | Liệt kê firmware |
| POST | `/api/v1/ota/firmware/:id/publish` | `ota:firmware:write` | Phát hành firmware |
| POST | `/api/v1/ota/firmware/:id/revoke` | `ota:firmware:write` | Thu hồi firmware |
| POST | `/api/v1/devices/:id/ota` | `ota:jobs:create` | Tạo OTA Job |
| GET | `/api/v1/ota/jobs` | `ota:jobs:read` | Tra cứu OTA Job |
| GET | `/ota/download/:token/:signature` | URL token/signature | Tải firmware |

### 9.6. Tạo OTA Job

Backend kiểm tra:
- Người yêu cầu có quyền và phạm vi thiết bị.
- Thiết bị `PROVISIONED` hoặc `ACTIVE`.
- Thiết bị `ONLINE`, heartbeat còn mới và MQTT session hợp lệ.
- Phòng học `ACTIVE`.
- Credential đã đồng bộ (`SYNCED`).
- Firmware `PUBLISHED`.
- Device type và hardware target tương thích.
- Thiết bị chưa có job đang hoạt động.

Sau đó Backend tạo job, lưu session/credential version và firmware version trước cập nhật, tạo outbox rồi gửi lệnh MQTT.

Topic command:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/command
```

Topic status:

```text
smartclassroom/room/{room_code}/device/{device_code}/ota/status
```

### 9.7. Tải firmware và kiểm tra an toàn

Endpoint download kiểm tra:
1. HMAC-SHA256 của URL.
2. Token chưa hết hạn.
3. Firmware tồn tại và còn `PUBLISHED`.
4. Storage path trong token khớp database.
5. File tồn tại, kích thước khớp metadata.

Phân biệt:
- **Ed25519:** chữ ký hash firmware.
- **HMAC-SHA256:** chữ ký bảo vệ URL tải.

### 9.8. Chạy test OTA

Trước tiên bootstrap role/ACL trên broker test:

```powershell
npm run mqtt:bootstrap:test
```

Chạy riêng OTA:

```powershell
npm run test:ota
```

Chạy toàn bộ integration test:

```powershell
npm run test:integration
```

### 9.9. Các test OTA

Tài liệu ADV-05 hiện ghi nhận 15 test case, gồm:
1. Metadata UTF-8 percent-encoded và encoding không hợp lệ.
2. Metadata Unicode đầy đủ, Base64/UTF-8 sai.
3. Tạo OTA Job, publish MQTT, status, ACK/retry và vòng đời đến `SUCCESS`.
4. Đăng ký firmware hợp lệ.
5. Từ chối file rỗng.
6. Từ chối thiếu metadata.
7. Publish firmware và tạo chữ ký.
8. Từ chối publish lại.
9. Thu hồi firmware đã publish.
10. Từ chối thu hồi firmware `DRAFT`.
11. Danh sách firmware theo quyền.
12. Từ chối API khi thiếu token.
13. URL tải có chữ ký hợp lệ.
14. Từ chối URL sai chữ ký.
15. Từ chối URL hết hạn.

### 9.10. Đánh giá kết quả ADV-05

Tài liệu ghi nhận:
- Lần chạy OTA đầu tiên: 14/15 PASS, 1 FAIL do MQTT test broker trả `Not authorized` khi Subscribe.
- Sau khi chạy `npm run mqtt:bootstrap:test`, lần integration tiếp theo đạt 106/106 PASS, trong đó 15/15 test OTA PASS.
- GitHub Actions Backend checks và ESP32 Firmware Build đều Success tại commit được nêu trong tài liệu ADV-05.

Build firmware PASS chỉ chứng minh biên dịch thành công theo CI. Chưa xác nhận ESP32 thật tải firmware, xác minh Ed25519, ghi OTA partition, reboot hoặc rollback.

### 9.11. Kiểm thử phần cứng còn thiếu

Khi có board và firmware OTA phù hợp:
1. Build đúng target Sensor Node/Control Node.
2. Đăng ký và publish firmware tương thích.
3. Tạo OTA Job.
4. Xác nhận thiết bị nhận lệnh.
5. Tải firmware qua HTTPS.
6. Kiểm tra kích thước, SHA-256 và chữ ký Ed25519.
7. Ghi vào OTA partition.
8. Reboot và xác nhận firmware mới hoạt động.
9. Kiểm tra Backend nhận `SUCCESS` và cập nhật `firmware_version`.
10. Thử sai hash/chữ ký, URL hết hạn, mất mạng, mất nguồn và tình huống rollback.

Chỉ đánh dấu OTA phần cứng PASS khi có bằng chứng trên ESP32 thật.

---

## 10. Kiểm thử phối hợp 5 chức năng

Phần này là trình tự kiểm thử phối hợp đề xuất, không phải khẳng định rằng toàn bộ các bước đã được thực hiện.

### 10.1. Giai đoạn A — Nền tảng

1. Kiểm tra `.env` và `.env.test` đã cấu hình.
2. Khởi chạy PostgreSQL/MQTT test.
3. Áp dụng migration phù hợp.
4. Bootstrap MQTT test.
5. Chạy Backend.
6. Kiểm tra `/health` và `/ready`.

### 10.2. Giai đoạn B — Telemetry và offline

1. Sensor Node gửi telemetry bình thường.
2. Backend lưu telemetry và ACK `STORED`.
3. Ngắt mạng.
4. Sensor Node tiếp tục tạo dữ liệu và lưu LittleFS.
5. Khởi động lại thiết bị khi còn dữ liệu chờ.
6. Khôi phục mạng và quan sát gửi bù.
7. Kiểm tra không mất dữ liệu, không trùng dữ liệu và ACK đúng ID.

### 10.3. Giai đoạn C — Monitoring và Logging

1. Phát sinh telemetry, command và MQTT event.
2. Kiểm tra log JSON.
3. Kiểm tra key nhạy cảm được che.
4. Kiểm tra component status và heartbeat.
5. Kiểm tra counter.
6. Kiểm tra snapshot.
7. Xác nhận rõ Monitoring đã được bind vào runtime hay mới chỉ kiểm thử service độc lập.

### 10.4. Giai đoạn D — Phát hiện bất thường

1. Dùng telemetry hợp lệ của thiết bị ACTIVE/phòng ACTIVE.
2. Đưa đủ mẫu để baseline đạt `minSamples`.
3. Gửi giá trị bình thường.
4. Gửi giá trị lệch.
5. Kiểm tra `WARMING_UP`, `NORMAL`, `ANOMALY`.
6. Kiểm tra baseline không hấp thụ điểm bất thường.
7. Gửi event trùng, backfill, clock skew và dữ liệu không còn mới nhất.
8. Kiểm tra consumer bỏ qua hoặc xử lý theo điều kiện.

### 10.5. Giai đoạn E — Device Shadow

1. Tạo Control Node.
2. Truy vấn Shadow ban đầu.
3. Tạo command bật/tắt đèn hoặc quạt.
4. Kiểm tra Desired State/version.
5. Xác nhận Reported State chỉ thay đổi sau phản hồi hợp lệ.
6. Kiểm tra ACK sai session/version, ACK lặp và timeout.
7. Đối chiếu `in_sync` và `differences`.

### 10.6. Giai đoạn F — OTA

1. Đăng ký firmware.
2. Publish firmware.
3. Tạo OTA Job.
4. Quan sát command MQTT.
5. Kiểm tra status từ thiết bị.
6. Nếu có phần cứng OTA, xác nhận download, verify, install, reboot.
7. Kiểm tra kết quả và `firmware_version`.
8. Thử tình huống lỗi và rollback.

Không chạy kiểm thử phá hủy như mất nguồn/ghi flash trên thiết bị đang vận hành hoặc có dữ liệu cần giữ.

---

## 11. Đánh giá và ghi nhận kết quả

### 11.1. Quy trình đánh giá cho mỗi test case

Với mỗi test:
1. Ghi trạng thái ban đầu.
2. Ghi dữ liệu đầu vào và môi trường.
3. Thực hiện đúng các bước.
4. Thu phản hồi API, MQTT, log, database hoặc trạng thái thiết bị.
5. So sánh kết quả thực tế với kết quả mong đợi.
6. Gán trạng thái.
7. Lưu bằng chứng.

### 11.2. Quy ước trạng thái

| Trạng thái | Cách sử dụng |
|---|---|
| `PASS` | Đã thực hiện test và kết quả thực tế đáp ứng đầy đủ điều kiện mong đợi. |
| `FAIL` | Đã thực hiện test nhưng kết quả không đáp ứng điều kiện. |
| `BLOCKED` | Không thể thực hiện do thiếu thiết bị, dịch vụ, credential hoặc điều kiện tiên quyết. |
| `NOT TESTED` | Chưa chạy test. |
| `N/A` | Test không thuộc phạm vi cấu hình/thiết bị đang nghiệm thu; cần nêu lý do. |

Không đánh dấu PASS chỉ vì test case đã được viết hoặc source code có chức năng tương ứng.

### 11.3. Mẫu bảng ghi nhận kết quả

| ID | Chức năng | Môi trường | Dữ liệu/điều kiện | Kết quả mong đợi | Kết quả thực tế | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|---|---|
| ADV01-UT-01 | Device Shadow | Local Node.js | Tạo Shadow | Giá trị mặc định đúng | Điền sau khi chạy | — | Log test |
| ADV01-IT-01 | Commands/MQTT | PostgreSQL + MQTT test | Tạo command | ACK hợp lệ cập nhật Shadow | Điền sau khi chạy | — | Log + DB |
| ADV02-IT-01 | Offline sync | MQTT + PostgreSQL test | Gửi telemetry | Lưu một lần, ACK STORED | Điền sau khi chạy | — | Log + DB |
| ADV02-HW-01 | LittleFS | ESP32 thật | Ngắt mạng | Dữ liệu vẫn được lưu | Điền sau khi chạy | — | Ảnh/serial log |
| ADV03-UT-01 | Logging | Local Node.js | Log có secret key | Secret được che | Điền sau khi chạy | — | Log đã che |
| ADV04-UT-01 | Anomaly | Local Node.js | Baseline chưa đủ mẫu | WARMING_UP | Điền sau khi chạy | — | Test output |
| ADV04-IT-01 | Consumer | DB + Backend | telemetry.stored | Lưu kết quả/delivery đúng | Điền sau khi chạy | — | DB + log |
| ADV05-IT-01 | OTA | PostgreSQL + MQTT test | Tạo OTA Job | Job/command đúng | Điền sau khi chạy | — | Log + DB |
| ADV05-HW-01 | OTA device | ESP32 thật | Cập nhật firmware | Reboot và firmware mới chạy | Điền sau khi chạy | — | Serial log |

### 11.4. Đánh giá tổng hợp

Có thể báo cáo kết quả theo bốn nhóm:

- **Mức code/module:** module đã có trong repository.
- **Mức tự động:** unit test hoặc mock test đã chạy.
- **Mức tích hợp:** các thành phần thực tế như PostgreSQL/MQTT được phối hợp trong test.
- **Mức phần cứng:** ESP32 đã được nạp và kiểm tra trong tình huống thực tế.

Ví dụ cách viết kết luận đúng:
- “ADV-03 đạt 12/12 unit test; repository PostgreSQL hiện được kiểm thử bằng pool giả lập.”
- “ADV-04 đạt 16/16 test local; consumer test sử dụng mock PostgreSQL, chưa xác nhận PostgreSQL integration.”
- “ADV-05 đạt 15/15 OTA integration test trong lần chạy sau bootstrap MQTT test ACL; OTA trên ESP32 thật chưa nghiệm thu.”

Không viết “toàn bộ hệ thống đã hoạt động hoàn chỉnh” nếu chưa có kiểm thử đầu cuối.

---

## 12. Bảng lệnh kiểm thử tổng hợp

Chạy tại thư mục gốc repository.

| Chức năng | Lệnh | Phạm vi |
|---|---|---|
| ADV-01 | `npm run test:device-shadow` | Unit test Device Shadow |
| ADV-01 | `node --test tests/integration/commands.test.js` | Integration test Commands/Shadow |
| ADV-02 | `npm run test:telemetry-ingestion` | Test telemetry ingestion |
| ADV-02 | `npm run test:firmware-phase3` | Integration test Sensor Node/Phase 3 |
| ADV-02 | `node --test tests/integration/telemetry.test.js` | Integration test telemetry |
| ADV-03 | `npm run test:monitoring-logging` | Test Monitoring và Logging |
| ADV-04 | `npm run test:anomaly-detection` | Test anomaly detection và consumer |
| ADV-05 | `npm run mqtt:bootstrap:test` | Khởi tạo MQTT test role/ACL |
| ADV-05 | `npm run test:ota` | 15 OTA integration test |
| Tất cả | `npm test` | Unit/service/HTTP tests trong `tests/*.test.js` |
| Tất cả | `npm run test:integration` | Các file `tests/integration/*.test.js` |

**Chú ý về `npm test`:** script này không thay thế `npm run test:integration`; hai lệnh chạy các tập file khác nhau. Nếu muốn kiểm tra toàn bộ theo phạm vi repository, chạy cả hai sau khi đã chuẩn bị đúng môi trường.

---

## 13. Xử lý lỗi thường gặp

### 13.1. Database không kết nối

- Kiểm tra Docker container và cổng PostgreSQL.
- Kiểm tra `DATABASE_URL`, `TEST_DATABASE_URL` và `TEST_MIGRATION_DATABASE_URL`.
- Đảm bảo database test có tên kết thúc `_test` theo README.
- Không thay URL test bằng database ứng dụng để “chạy cho được”.

### 13.2. Migration lỗi hoặc thiếu bảng

- Kiểm tra migration đã chạy chưa.
- Xác nhận đang dùng đúng database.
- Đọc thông báo lỗi và migration tương ứng.
- Không sửa migration đã áp dụng; nếu cần thay đổi schema, tạo migration mới theo quy tắc dự án.

### 13.3. MQTT `Not authorized`

- Kiểm tra đúng broker và credential.
- Với broker test, chạy:

```powershell
npm run mqtt:bootstrap:test
```

- Kiểm tra role/ACL và topic của client.
- Không kết luận lỗi nghiệp vụ OTA/telemetry khi nguyên nhân thực tế là broker từ chối Subscribe/Publish.

### 13.4. Device Shadow không đồng bộ

- Kiểm tra Desired State và Reported State riêng biệt.
- Kiểm tra `command_id`, `session_id`, `shadow_version`.
- Kiểm tra ACK đúng thiết bị và đúng phiên.
- Không tự cập nhật Reported State ngay sau khi publish command.

### 13.5. Offline queue không xóa bản ghi

- Kiểm tra ACK đúng định dạng legacy/hiện hành.
- Kiểm tra ID khớp bản ghi đầu hàng đợi.
- Kiểm tra `status = STORED`.
- Kiểm tra thiết bị có subscribe đúng ACK topic không.
- Không xóa bản ghi thủ công để làm test “đạt”.

### 13.6. Monitoring không có event

- Kiểm tra nơi đăng ký `bindMonitoring()`.
- Kiểm tra MQTT runtime có phát `device-message`.
- Kiểm tra service và repository.
- Phân biệt test service độc lập với tích hợp runtime thực tế.

### 13.7. Anomaly không trả kết quả như mong đợi

- Kiểm tra baseline hiện có và số mẫu.
- Kiểm tra metric và đơn vị.
- Kiểm tra `eligible`, `is_latest`, `is_backfill`, `clock_skew`.
- Kiểm tra trạng thái thiết bị/phòng.
- Kiểm tra event/data ID đã được xử lý chưa.
- Lưu ý MAD bằng 0 có quy tắc riêng.

### 13.8. OTA không tạo job hoặc không publish

- Kiểm tra firmware có `PUBLISHED`.
- Kiểm tra device type/hardware target.
- Kiểm tra thiết bị online, heartbeat, session và credential.
- Kiểm tra thiết bị có OTA Job đang hoạt động không.
- Kiểm tra outbox và MQTT ACL.
- Phân biệt Backend publish lệnh với thiết bị thực sự cài firmware.

---

## 14. Checklist nghiệm thu

### 14.1. ADV-01 — Device Shadow

- [ ] Shadow được tạo cho Control Node.
- [ ] Desired State và Reported State được lưu riêng.
- [ ] Tạo command làm tăng version mong muốn.
- [ ] MQTT command đúng topic/payload.
- [ ] Reported State chỉ thay đổi sau phản hồi hợp lệ.
- [ ] `in_sync` và `differences` đúng.
- [ ] Kiểm tra ACK sai session/version, ACK lặp và timeout.
- [ ] Kiểm thử ESP32/Mosquitto thật nếu nghiệm thu đầu cuối.

### 14.2. ADV-02 — Offline Synchronization

- [ ] Telemetry được ghi LittleFS trước khi gửi.
- [ ] Mất Wi-Fi/MQTT không làm mất bản ghi chờ.
- [ ] Hàng đợi phục hồi sau reboot.
- [ ] Kết nối lại gửi bù theo thứ tự.
- [ ] Chỉ ACK `STORED` đúng ID mới xóa bản ghi.
- [ ] Backend chống trùng.
- [ ] Backfill không ghi đè dữ liệu latest.
- [ ] Kiểm thử ESP32 thật.

### 14.3. ADV-03 — Monitoring và Logging

- [ ] Log JSON đúng cấu trúc.
- [ ] Key nhạy cảm được che.
- [ ] Input không hợp lệ bị từ chối.
- [ ] Component status cập nhật đúng.
- [ ] Heartbeat online/offline đúng ngưỡng.
- [ ] Counter tăng đúng.
- [ ] Snapshot tổng hợp đúng.
- [ ] Đã xác nhận bind MQTT runtime.
- [ ] Đã kiểm tra PostgreSQL thật nếu thuộc phạm vi nghiệm thu.
- [ ] Dashboard được xác nhận nếu yêu cầu giao diện.

### 14.4. ADV-04 — Anomaly Detection

- [ ] Migration `016_anomaly_detection.sql` áp dụng thành công.
- [ ] Baseline tách theo thiết bị/metric.
- [ ] Chưa đủ mẫu trả `WARMING_UP`.
- [ ] Mẫu bình thường trả `NORMAL`.
- [ ] Mẫu lệch trả `ANOMALY`.
- [ ] Mẫu bất thường không thêm vào baseline.
- [ ] Event trùng không xử lý lặp.
- [ ] Backfill/clock skew/không latest được bỏ qua.
- [ ] Lỗi lưu kết quả rollback và không đánh dấu delivery.
- [ ] Đã kiểm thử PostgreSQL/MQTT thật nếu nghiệm thu tích hợp.
- [ ] Có dữ liệu thực nghiệm nếu đánh giá chất lượng phát hiện.

### 14.5. ADV-05 — OTA

- [ ] Đăng ký firmware và lưu metadata/hash.
- [ ] Publish sau khi kiểm tra lại file.
- [ ] Thu hồi firmware đúng điều kiện.
- [ ] Tạo OTA Job cho thiết bị tương thích.
- [ ] Outbox gửi/retry MQTT đúng.
- [ ] Backend xác thực status theo job/device/session/credential.
- [ ] URL tải kiểm tra chữ ký và thời hạn.
- [ ] ESP32 tải firmware và kiểm tra SHA-256.
- [ ] ESP32 xác minh Ed25519.
- [ ] ESP32 cài đặt, reboot và xác nhận phiên bản.
- [ ] Đã thử lỗi tải/cài đặt/mất nguồn.
- [ ] Đã kiểm thử rollback trên phần cứng thật.

### 14.6. Quy tắc kết luận cuối cùng

- Chỉ có mã nguồn: **Đã triển khai module**.
- Test tự động đã chạy: **Đã kiểm thử tự động**, ghi rõ số test và loại test.
- Test dùng mock/in-memory: ghi rõ phạm vi mock/in-memory.
- PostgreSQL/MQTT thật đã chạy: ghi rõ môi trường và bằng chứng.
- ESP32 thật đã kiểm thử: ghi rõ board, firmware, tình huống và kết quả.
- Chưa thực hiện: ghi **Chưa kiểm thử**, **BLOCKED** hoặc **Chưa xác nhận**; không ghi PASS.

---

## 15. Kết luận

Năm chức năng ADV bổ sung các năng lực quan trọng cho hệ thống phòng học thông minh: quản lý trạng thái thiết bị, lưu dữ liệu khi mất mạng và đồng bộ lại, giám sát/logging, phát hiện dữ liệu môi trường bất thường và cập nhật firmware từ xa.

Quy trình triển khai và kiểm thử cần đi từ nền tảng database/MQTT, kiểm thử từng module, kiểm thử phối hợp, rồi mới nghiệm thu phần cứng. Các kết quả unit test, mock test, integration test, CI build và kiểm thử ESP32 là những mức bằng chứng khác nhau.

Khi báo cáo, phải phân biệt rõ **đã triển khai**, **đã kiểm thử tự động**, **đã kiểm thử tích hợp** và **đã nghiệm thu phần cứng**. Chỉ kết luận trong phạm vi mà kết quả thực tế và bằng chứng kiểm thử hỗ trợ.
