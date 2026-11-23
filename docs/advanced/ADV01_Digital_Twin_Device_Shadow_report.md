# ADV-01 --- Digital Twin / Device Shadow

## 1. Tổng quan

**Mã chức năng:** ADV-01\
**Tên chức năng:** Digital Twin / Device Shadow\
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)\
**Trạng thái:** Đã triển khai module nghiệp vụ, tích hợp với luồng điều
khiển thiết bị và PostgreSQL; đã có unit test. Việc kiểm thử đầu cuối
với ESP32 và Mosquitto cần được xác nhận riêng.

### 1.1. Mục tiêu

Digital Twin / Device Shadow duy trì một bản thể số đại diện cho trạng
thái thiết bị IoT. Hệ thống quản lý đồng thời:

-   **Desired State:** Trạng thái mà hệ thống mong muốn thiết bị đạt
    được.
-   **Reported State:** Trạng thái thực tế do thiết bị gửi về backend.

Việc so sánh hai trạng thái giúp xác định thiết bị đã thực hiện đúng yêu
cầu hay chưa, phát hiện thuộc tính chưa đồng bộ và cung cấp thông tin
phục vụ giám sát, điều khiển.

### 1.2. Phạm vi chức năng

-   Duy trì trạng thái mong muốn và trạng thái thực tế của Control Node.
-   Quản lý phiên bản trạng thái.
-   Xác định mức độ đồng bộ giữa Desired State và Reported State.
-   Phát hiện và trả về thuộc tính có trạng thái khác nhau.
-   Theo dõi lệnh điều khiển gần nhất.
-   Phối hợp với chức năng điều khiển để cập nhật Desired State.
-   Tiếp nhận ACK và Reported State thông qua MQTT.
-   Chỉ cập nhật trạng thái thực tế dựa trên dữ liệu phản hồi hợp lệ.
-   Lưu trữ thông tin Shadow và lịch sử lệnh trong PostgreSQL.

  Cơ cấu chấp hành   Trạng thái
  ------------------ -------------
  Đèn (`light`)      `ON`, `OFF`
  Quạt (`fan`)       `ON`, `OFF`

Reported State còn sử dụng `UNKNOWN` để biểu thị trạng thái thực tế chưa
được xác định.

## 2. Nguyên lý hoạt động

### 2.1. Nguyên lý quản lý trạng thái

Mỗi Control Node được gắn với một Device Shadow lưu trữ trạng thái đại
diện. Khi chưa nhận được trạng thái thực tế hợp lệ, Reported State được
khởi tạo là `UNKNOWN`; Desired State được khởi tạo theo trạng thái mặc
định của cơ cấu chấp hành.

Khi có yêu cầu điều khiển, hệ thống cập nhật Desired State và tăng phiên
bản Shadow. Reported State không thay đổi ngay khi tạo lệnh mà chỉ được
cập nhật khi nhận dữ liệu phản hồi hợp lệ từ thiết bị.

### 2.2. Quy trình hoạt động

1.  **Khởi tạo Device Shadow:** Khi Control Node được đăng ký, hệ thống
    tạo bản ghi Device Shadow trong cơ sở dữ liệu.
2.  **Tiếp nhận yêu cầu:** Người dùng hoặc chức năng tự động hóa gửi yêu
    cầu thay đổi trạng thái cơ cấu chấp hành.
3.  **Kiểm tra yêu cầu:** Backend kiểm tra dữ liệu, quyền điều khiển,
    trạng thái thiết bị, phòng học và kết nối MQTT.
4.  **Cập nhật Desired State:** Hệ thống tạo `command_id`, tăng phiên
    bản Shadow và cập nhật trạng thái mong muốn.
5.  **Lưu trữ lệnh:** Lệnh, Desired State, nhật ký và sự kiện liên quan
    được ghi nhận trong cùng transaction.
6.  **Gửi lệnh MQTT:** Sau khi transaction hoàn tất, backend gửi lệnh
    đến Control Node.
7.  **Tiếp nhận phản hồi:** Thiết bị gửi ACK hoặc Reported State về
    backend.
8.  **Kiểm tra phản hồi:** Backend xác minh mã thiết bị, phòng học,
    phiên kết nối, phiên bản Shadow và thông tin lệnh.
9.  **Cập nhật Reported State:** Nếu dữ liệu hợp lệ và không cũ hơn dữ
    liệu đã ghi nhận, hệ thống cập nhật trạng thái thực tế.
10. **Đánh giá đồng bộ:** Device Shadow so sánh Desired State với
    Reported State và xác định thuộc tính còn chênh lệch.
11. **Cung cấp kết quả:** Backend cung cấp thông tin Shadow, trạng thái
    lệnh gần nhất và kết quả đồng bộ.

### 2.3. Ý nghĩa trạng thái

  -----------------------------------------------------------------------
  Thành phần                          Ý nghĩa
  ----------------------------------- -----------------------------------
  `desired_state`                     Trạng thái mong muốn

  `reported_state`                    Trạng thái thực tế do thiết bị báo
                                      cáo

  `shadow_version`                    Phiên bản Desired State

  `reported_version`                  Phiên bản trạng thái thực tế đã ghi
                                      nhận

  `in_sync`                           Các thuộc tính mong muốn đã khớp
                                      trạng thái thực tế hay chưa

  `differences`                       Các thuộc tính có Desired và
                                      Reported khác nhau

  `last_reported_at`                  Thời điểm nhận trạng thái thực tế
                                      gần nhất

  `last_command_error`                Mã lỗi lệnh gần nhất nếu có
  -----------------------------------------------------------------------

Trạng thái xử lý lệnh:

  Trạng thái   Ý nghĩa
  ------------ ---------------------------------------------------
  `PENDING`    Lệnh đã tạo và đang chờ kết quả
  `SUCCESS`    Thiết bị phản hồi thành công
  `FAILED`     Lệnh thực hiện thất bại
  `TIMEOUT`    Không nhận được phản hồi trong thời gian quy định

Publish thành công qua MQTT không đồng nghĩa thiết bị đã thực hiện thành
công. Hệ thống cần phản hồi hợp lệ để ghi nhận kết quả.

## 3. Kiến trúc và cấu trúc source code

### 3.1. Các thành phần

  -----------------------------------------------------------------------
  Thành phần                          Vai trò
  ----------------------------------- -----------------------------------
  `DeviceShadowService`               Truy vấn Device Shadow, tính chênh
                                      lệch và xác định trạng thái đồng bộ

  `PostgresDeviceShadowRepository`    Truy vấn Shadow và lệnh điều khiển
                                      từ PostgreSQL

  `CommandsService`                   Tạo lệnh, cập nhật Desired State,
                                      gửi MQTT, tiếp nhận ACK và truy vấn
                                      Shadow

  `command-state.js`                  Cập nhật Reported State, kết thúc
                                      lệnh và xử lý phản hồi đến muộn

  MQTT Client                         Truyền lệnh và nhận phản hồi từ
                                      thiết bị

  PostgreSQL                          Lưu Device Shadow, trạng thái cơ
                                      cấu chấp hành và lịch sử lệnh

  Control Node (ESP32)                Nhận lệnh, thực thi điều khiển và
                                      gửi trạng thái thực tế
  -----------------------------------------------------------------------

### 3.2. Cấu trúc source code

``` text
backend/
└── src/
    └── modules/
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

database/
└── migrations/
    └── 008_commands_shadow.sql

tests/
├── device-shadow.test.js
└── integration/
    └── commands.test.js
```

### 3.3. Trách nhiệm file

  --------------------------------------------------------------------------
  File                                   Trách nhiệm
  -------------------------------------- -----------------------------------
  `device-shadow.errors.js`              Định nghĩa lỗi nghiệp vụ Device
                                         Shadow

  `device-shadow.mqtt.js`                Chuẩn hóa MQTT topic và hỗ trợ
                                         publish lệnh

  `device-shadow.repository.memory.js`   Repository in-memory phục vụ kiểm
                                         thử

  `device-shadow.repository.pg.js`       Truy vấn Shadow và lệnh từ
                                         PostgreSQL

  `device-shadow.service.js`             Kiểm tra trạng thái yêu cầu, tính
                                         chênh lệch và xác định đồng bộ

  `command-schemas.js`                   Kiểm tra cấu trúc lệnh, ACK và
                                         Reported State

  `command-state.js`                     Cập nhật trạng thái thực tế, kết
                                         quả lệnh và phản hồi đến muộn

  `commands.routes.js`                   Khai báo điểm truy cập tạo lệnh,
                                         truy vấn Shadow và lịch sử lệnh

  `commands.service.js`                  Điều phối quy trình điều khiển và
                                         phối hợp với Device Shadow

  `008_commands_shadow.sql`              Khởi tạo bảng và trường dữ liệu
                                         phục vụ Shadow và lệnh

  `device-shadow.test.js`                Kiểm thử đơn vị nghiệp vụ Device
                                         Shadow

  `tests/integration/commands.test.js`   Kiểm thử tích hợp luồng điều khiển
                                         và đồng bộ trạng thái
  --------------------------------------------------------------------------

## 4. Thiết kế dữ liệu

### 4.1. Bảng `device_shadows`

  -----------------------------------------------------------------------
  Trường                              Ý nghĩa
  ----------------------------------- -----------------------------------
  `device_id`                         Mã thiết bị, khóa chính và khóa
                                      ngoại tham chiếu `devices`

  `desired_state`                     Trạng thái mong muốn, lưu dạng
                                      JSONB

  `reported_state`                    Trạng thái thực tế, lưu dạng JSONB

  `desired_version`                   Phiên bản trạng thái mong muốn

  `reported_version`                  Phiên bản trạng thái thực tế

  `last_reported_at`                  Thời điểm nhận trạng thái thực tế
                                      gần nhất

  `last_command_error`                Mã lỗi lệnh gần nhất nếu có

  `updated_at`                        Thời điểm cập nhật
  -----------------------------------------------------------------------

Ví dụ:

``` json
{
  "desired_state": {"light": "ON", "fan": "OFF"},
  "reported_state": {"light": "OFF", "fan": "OFF"},
  "desired_version": 2,
  "reported_version": 1
}
```

Ví dụ cho thấy hệ thống đã yêu cầu bật đèn nhưng thiết bị vẫn báo cáo
đèn đang tắt, do đó trạng thái chưa đồng bộ.

### 4.2. Bảng `commands`

  Trường                      Ý nghĩa
  --------------------------- --------------------------------------------
  `command_id`                Mã định danh duy nhất
  `device_id`                 Thiết bị nhận lệnh
  `room_id`                   Phòng học chứa thiết bị
  `desired_state`             Các thuộc tính cần thay đổi
  `shadow_version`            Phiên bản Shadow gắn với lệnh
  `session_id`                Phiên kết nối thiết bị khi tạo lệnh
  `credential_version`        Phiên bản thông tin xác thực thiết bị
  `source`                    Nguồn tạo lệnh: `MANUAL` hoặc `AUTOMATION`
  `requested_by`              Người dùng yêu cầu nếu là lệnh thủ công
  `requested_token_version`   Phiên bản token của người yêu cầu
  `rule_id`                   Mã quy tắc tự động hóa nếu có
  `request_id`                Mã định danh yêu cầu
  `status`                    Trạng thái xử lý
  `created_at`                Thời điểm tạo
  `timeout_at`                Thời điểm hết hạn
  `published_at`              Thời điểm gửi thành công
  `acked_at`                  Thời điểm ghi nhận ACK
  `late_ack_at`               Thời điểm nhận ACK đến muộn
  `error_code`                Mã lỗi nếu có
  `ack_payload`               Nội dung ACK đã nhận

### 4.3. Bảng `actuators`

  Trường                    Ý nghĩa
  ------------------------- ----------------------------------
  `desired_state`           Trạng thái mong muốn
  `current_state`           Trạng thái thực tế đã ghi nhận
  `desired_version`         Phiên bản trạng thái mong muốn
  `reported_version`        Phiên bản trạng thái thực tế
  `reported_session_id`     Phiên thiết bị gửi trạng thái
  `reported_timestamp_ms`   Timestamp của dữ liệu trạng thái

Lưu phiên bản theo từng cơ cấu chấp hành giúp xử lý các phản hồi đèn và
quạt đến không theo thứ tự, hạn chế dữ liệu cũ ghi đè trạng thái mới.

### 4.4. Bảng `command_idempotency`

  Trường           Ý nghĩa
  ---------------- ------------------------------
  `user_id`        Người dùng gửi yêu cầu
  `device_id`      Thiết bị nhận lệnh
  `key`            Khóa idempotency
  `payload_hash`   Giá trị băm nội dung yêu cầu
  `command_id`     Lệnh đã tạo tương ứng
  `expires_at`     Thời điểm hết hiệu lực

Nếu người dùng gửi lại yêu cầu với cùng khóa và cùng nội dung, hệ thống
trả về lệnh đã tồn tại thay vì tạo lệnh mới. Nếu nội dung khác, hệ thống
từ chối bằng lỗi `IDEMPOTENCY_CONFLICT`.

## 5. Thiết kế giao tiếp MQTT

### 5.1. Topic điều khiển

``` text
smartclassroom/room/{roomCode}/device/{deviceId}/command
```

Trong đó `roomCode` là mã phòng, `deviceId` là mã Control Node và
`command` là nhánh topic điều khiển. Các thành phần mã phòng và mã thiết
bị chỉ chấp nhận chữ cái ASCII, chữ số, dấu gạch dưới và dấu gạch ngang.

### 5.2. Payload lệnh điều khiển

``` json
{
  "command_id": "UUID",
  "device_id": "CTRL_01",
  "room_id": "ROOM_302",
  "session_id": "boot-1",
  "shadow_version": 2,
  "desired_state": {"fan": "ON"},
  "timestamp": 1793181600000,
  "expires_at": 1793181605000
}
```

### 5.3. Payload Reported State và ACK

Bản tin Reported State:

``` json
{
  "device_id": "CTRL_01",
  "room_id": "ROOM_302",
  "session_id": "boot-1",
  "shadow_version": 2,
  "timestamp": 1793181601000,
  "reported_state": {"fan": "ON"}
}
```

Đối với ACK, thiết bị gửi thêm `command_id` và `status`:

``` json
{
  "command_id": "UUID",
  "device_id": "CTRL_01",
  "room_id": "ROOM_302",
  "session_id": "boot-1",
  "shadow_version": 2,
  "status": "SUCCESS",
  "reported_state": {"fan": "ON"},
  "timestamp": 1793181601000
}
```

Backend chỉ chấp nhận ACK có cấu trúc hợp lệ, đúng thiết bị, đúng lệnh,
đúng phiên kết nối và đúng phiên bản. Với ACK thành công, trạng thái báo
cáo phải khớp trạng thái được yêu cầu.

## 6. Các nghiệp vụ xử lý chính

### 6.1. Khởi tạo Device Shadow

Khi Control Node được tạo trong hệ thống, bản ghi Device Shadow tương
ứng được khởi tạo trong cơ sở dữ liệu:

-   Desired State: `light = OFF`, `fan = OFF`.
-   Reported State: `light = UNKNOWN`, `fan = UNKNOWN`.
-   Desired Version: `1`.
-   Reported Version: `0`.

`UNKNOWN` giúp phân biệt trạng thái mặc định mong muốn với trạng thái
thực tế chưa được thiết bị xác nhận.

### 6.2. Cập nhật Desired State

Khi người dùng hoặc chức năng tự động hóa yêu cầu thay đổi trạng thái,
`CommandsService`:

1.  Kiểm tra dữ liệu trạng thái yêu cầu.
2.  Kiểm tra quyền điều khiển và phạm vi thiết bị.
3.  Kiểm tra thiết bị đang hoạt động và có kết nối hợp lệ.
4.  Khóa bản ghi Device Shadow trong transaction.
5.  Tăng `desired_version`.
6.  Tạo lệnh mới với trạng thái `PENDING`.
7.  Cập nhật `desired_state`.
8.  Ghi nhật ký và sự kiện liên quan.
9.  Hoàn tất transaction trước khi gửi lệnh MQTT.

Reported State không thay đổi vì thiết bị chưa xác nhận thực hiện lệnh.

### 6.3. Cập nhật Reported State

Khi nhận bản tin Reported State, backend kiểm tra mã thiết bị, mã phòng,
phiên kết nối, phiên bản Shadow, cấu trúc trạng thái và timestamp. Dữ
liệu chỉ được ghi nhận nếu hợp lệ và mới hơn trạng thái đã lưu. Hệ thống
cập nhật theo từng cơ cấu chấp hành, sau đó tổng hợp thành Reported
State của Device Shadow.

### 6.4. Xử lý ACK

-   ACK thành công và trạng thái báo cáo khớp yêu cầu: lệnh chuyển
    `SUCCESS`.
-   Thiết bị phản hồi thất bại: lệnh chuyển `FAILED`.
-   Hết thời gian chờ: lệnh chuyển `TIMEOUT`.
-   ACK đến muộn hoặc bị gửi lặp: không ghi đè kết quả cuối cùng của
    lệnh.
-   ACK không khớp thiết bị, phiên kết nối hoặc phiên bản: bị từ chối.

Việc xử lý kết quả lệnh được thực hiện trong transaction để bảo đảm tính
nhất quán giữa trạng thái lệnh, nhật ký và sự kiện hệ thống.

### 6.5. Xác định trạng thái đồng bộ

Ví dụ đầu vào:

``` json
{
  "desired_state": {"light": "ON", "fan": "OFF"},
  "reported_state": {"light": "OFF", "fan": "OFF"}
}
```

Kết quả:

``` json
{
  "in_sync": false,
  "differences": {
    "light": {"desired": "ON", "reported": "OFF"}
  }
}
```

Nếu tất cả thuộc tính đều khớp, `in_sync` là `true` và `differences` là
object rỗng.

## 7. Giao diện truy vấn và phân quyền

### 7.1. Các điểm truy cập chức năng

  Phương thức   Đường dẫn                 Chức năng
  ------------- ------------------------- -----------------------------------
  `GET`         `/devices/:id/shadow`     Truy vấn trạng thái Device Shadow
  `POST`        `/devices/:id/commands`   Tạo lệnh điều khiển thiết bị
  `GET`         `/devices/:id/commands`   Truy vấn lịch sử lệnh

Các điểm truy cập được khai báo trong `commands.routes.js`.

### 7.2. Phân quyền

  Quyền               Mục đích
  ------------------- ----------------------------------------
  `commands:read`     Truy vấn Device Shadow và lịch sử lệnh
  `commands:create`   Tạo lệnh điều khiển

Backend xác minh thiết bị thuộc phạm vi quản lý của người dùng. Sensor
Node không được phép truy vấn Device Shadow điều khiển. Với lệnh thủ
công, backend kiểm tra lại quyền người yêu cầu ngay trước khi publish để
tránh trường hợp quyền bị thu hồi sau khi lệnh được tạo.

## 8. Kiểm thử và đánh giá

### 8.1. Công cụ kiểm thử

Chức năng sử dụng `node:test` có sẵn trong Node.js.

``` powershell
npm run test:device-shadow
```

### 8.2. Các trường hợp kiểm thử đơn vị

    STT Trường hợp kiểm thử                                    Kết quả
  ----- ------------------------------------------------------ ---------
      1 Tạo Device Shadow với trạng thái ban đầu               PASS
      2 Phát hiện chênh lệch Desired State và Reported State   PASS
      3 Xác định Reported State `UNKNOWN` là chưa đồng bộ      PASS
      4 Lấy thông tin lệnh điều khiển gần nhất                 PASS
      5 Báo lỗi khi không tìm thấy Device Shadow               PASS
      6 Chấp nhận trạng thái điều khiển hợp lệ                 PASS
      7 Từ chối trạng thái điều khiển không hợp lệ             PASS
      8 Từ chối Desired State rỗng                             PASS
      9 Từ chối Desired State không phải object                PASS
     10 Tạo MQTT command topic hợp lệ                          PASS
     11 Từ chối MQTT topic chứa ký tự không hợp lệ             PASS

### 8.3. Kết quả chạy thực tế

**Kết quả: 11/11 tests PASS**

  Chỉ tiêu          Kết quả
  --------------- ---------
  Tổng số tests          11
  Passed                 11
  Failed                  0
  Cancelled               0
  Skipped                 0
  Todo                    0

Nguồn: Ảnh chụp kết quả chạy `npm run test:device-shadow` do người dùng
cung cấp ngày 04/11/2026.

Kết quả cho thấy các nghiệp vụ truy vấn Shadow, tính toán chênh lệch
trạng thái, kiểm tra dữ liệu và chuẩn hóa MQTT topic đều vượt qua các
trường hợp kiểm thử đơn vị.

Repository còn có `tests/integration/commands.test.js`, bao gồm các tình
huống gửi lệnh MQTT, idempotency, phân quyền, ACK sai thứ tự, timeout,
ACK đến muộn, lỗi publish, lỗi transaction, thiết bị kết nối lại và ACK
không hợp lệ. Đây là phạm vi kiểm thử tích hợp của luồng Commands và
Device Shadow. Chưa có kết quả chạy tích hợp được cung cấp trong lần
kiểm tra này nên không kết luận các trường hợp trên đã PASS ở local.

## 9. Hạn chế và hướng phát triển

1.  **Kiểm thử phần cứng:** Xác nhận Control Node ESP32 gửi đúng cấu
    trúc ACK và Reported State.
2.  **Kiểm thử MQTT đầu cuối:** Kiểm tra luồng truyền lệnh và phản hồi
    với Mosquitto và thiết bị thực tế.
3.  **Đồng bộ giao diện:** Hoàn thiện hiển thị Desired State, Reported
    State, trạng thái đồng bộ và lịch sử lệnh.
4.  **Giám sát trạng thái:** Bổ sung cảnh báo khi thiết bị không đồng bộ
    lâu hoặc liên tục thực hiện lệnh thất bại.
5.  **Mở rộng cơ cấu chấp hành:** Bổ sung loại thiết bị khác khi phần
    cứng và firmware hỗ trợ.
6.  **Tối ưu xử lý:** Đánh giá hiệu năng khi số lượng thiết bị và tần
    suất gửi trạng thái tăng.

## 10. Kết luận

ADV-01 --- Digital Twin / Device Shadow cung cấp cơ chế duy trì trạng
thái số đại diện cho các thiết bị điều khiển trong hệ thống phòng học
thông minh. Chức năng cho phép backend quản lý trạng thái mong muốn,
trạng thái thực tế, phiên bản trạng thái và kết quả lệnh điều khiển.

Việc tách biệt Desired State và Reported State giúp hệ thống xác định
tình trạng đồng bộ, tránh ghi nhận sai trạng thái khi lệnh mới chỉ được
gửi đi nhưng chưa có phản hồi xác nhận.

Chức năng đã được triển khai với PostgreSQL, phối hợp cùng luồng
Commands và MQTT, đồng thời có bộ unit test gồm 11 trường hợp đều đạt
kết quả PASS. Đây là cơ sở để phát triển các chức năng giám sát và điều
khiển thiết bị ở mức toàn hệ thống.
