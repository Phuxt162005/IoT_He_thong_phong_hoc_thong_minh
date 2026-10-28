# Hợp đồng backend v1 (BE-00)

Trạng thái: hợp đồng triển khai. Các endpoint dưới đây được bổ sung theo mã BE trong kế hoạch, không có nghĩa tất cả đã có code. Nguồn đối chiếu: chương VII–XI của tài liệu thiết kế trong repo và mục 4.4–4.5 của đề bài.

## Quyết định tương thích

| Vấn đề | Quyết định v1 | Kiểm chứng |
| --- | --- | --- |
| API và database | JSON API và tên cột dùng `snake_case`; API gốc `/api/v1`. Service cũ có thể giữ `camelCase`, chuyển đổi ở adapter. | BE-01, BE-08, BE-10 |
| ID | API dùng ID nội bộ trong URL; MQTT dùng `room_code`/`device_code`. `room_id`/`device_id` trong payload MQTT thiết kế là mã nghiệp vụ, không phải khóa số database. | BE-05–08 |
| Định dạng MQTT | Payload thiết kế (`msg_id`, `device_id`, `room_id`, timestamp mili giây) là chuẩn. Chấp nhận payload legacy đang có qua adapter; không đoán đơn vị theo độ dài timestamp. Không cho trộn hai định dạng trong cùng bản tin. | BE-08 |
| Legacy telemetry | `eventId` → `msg_id`, `deviceId` → `device_id`, `roomCode` → `room_id`; `temperatureC`/`humidityPercent`/`illuminanceLux` → `data.temperature`/`humidity`/`lux`. Timestamp ISO chuyển sang mili giây. Legacy thiếu occupancy lưu NULL và không dùng rule cần occupancy; bản tin chuẩn phải có occupancy. | BE-08, BE-13 |
| Chống trùng | Khóa database `(device_id nội bộ, msg_id)`; ACK sau commit. Bản tin trùng được ACK lại, không kích hoạt lại automation/alert. Cùng khóa nhưng payload khác bị từ chối, không nhận là retry hợp lệ. | BE-08 |
| Đồng hồ | Lưu thời điểm đo và nhận riêng, UTC. Timestamp chuẩn là mili giây nguyên không âm; legacy ISO hợp lệ hoặc rỗng. Quyết định BE-08 để giữ ADV-02: thời gian quá khứ được giữ nguyên dù quá 5 phút, coi là backfill; chỉ thiếu thời gian hoặc vượt tương lai >5 phút mới gắn clock_skew và dùng received_at. Mẫu clock_skew chỉ vào lịch sử, không cập nhật latest/automation. Mẫu cũ hơn latest hoặc quá TELEMETRY_FRESHNESS_S (30 giây) không điều khiển. | BE-08–09, BE-13 |
| Giá trị legacy | Legacy thiếu occupancy lưu NULL, không suy diễn phòng vắng; lux legacy được giữ phần thập phân theo service cũ. Database lưu số thực có CHECK giới hạn; bản tin chuẩn vẫn yêu cầu lux nguyên và occupancy boolean. | BE-08, BE-13 |
| Kết quả lệnh | API/DB: PENDING → SUCCESS / FAILED / TIMEOUT, trạng thái cuối bất biến. SENT chỉ là thời điểm publish, không chứng minh thực thi. Adapter ánh xạ service cũ ACKNOWLEDGED → SUCCESS, PUBLISH_FAILED → FAILED; không đổi test legacy ngầm. | BE-10 |
| Trạng thái thực | desired chỉ thể hiện yêu cầu; reported chỉ cập nhật từ thiết bị. Có version/correlation chống ACK/reported cũ ghi đè trạng thái mới. | BE-10 |
| ACK/reported BE-10 | Bắt buộc session_id hiện tại; command còn gắn credential version và expires_at. Phiên mới đặt reported về UNKNOWN tới khi có snapshot thật. Version được theo dõi riêng mỗi actuator để ACK quạt/đèn đến khác thứ tự vẫn đúng; timestamp phân biệt các snapshot cùng version. ACK muộn không đổi trạng thái cuối của lệnh, chỉ cập nhật trạng thái thực nếu không ghi đè version mới hơn. | BE-10 |
| Broker | Dynamic Security, credential riêng cho thiết bị, ACL theo mã và loại node; username và client ID đều bằng device_code. BE-09 yêu cầu session_id mới mỗi lần CONNECT, không chỉ mỗi lần boot, để loại LWT/heartbeat phiên cũ. Thiết bị không được publish command hoặc subscribe dữ liệu thiết bị khác. Backend đối chiếu phòng trong topic với database. | BE-07–09 |
| Khóa thiết bị | Thu hồi credential phải chặn phiên đang kết nối và reconnect; backend chặn ingestion/command ngay. Theo mục 9.3.2, DB cập nhật trước; broker lỗi trả 202/PENDING và retry qua outbox, không báo đã đồng bộ. Secret retry mã hóa, xóa sau APPLIED. | BE-06–08 |

## MQTT

Topic gốc: `smartclassroom/room/{room_code}/device/{device_code}`. Mã khớp `^[A-Za-z0-9_-]{1,40}$`, không có `/`, `+`, `#`. Giới hạn payload 2048 byte trước parse; JSON object; reject trường/kiểu không hợp lệ. `msg_id`: chuỗi 1–64 ký tự. `device_id` và `room_id` bắt buộc khớp topic.

| Hậu tố | Publisher → subscriber | QoS | Retain | Nội dung |
| --- | --- | --- | --- | --- |
| `/telemetry` | SENSOR_NODE → backend | 0 hoặc 1; firmware legacy đang publish 0 | false | nhiệt độ °C [-10,60], độ ẩm % [0,100], lux nguyên [0,65535], occupancy boolean |
| `/telemetry/ack` | backend → SENSOR_NODE | 1 | false | xác nhận STORED, msg_id, duplicate; legacy nhận eventId và messageType như hiện tại |
| `/heartbeat` | cả hai loại node → backend | 0 | false | uptime_seconds, free_heap_bytes, wifi_rssi_dbm, firmware_version tùy chọn |
| `/status` | thiết bị / LWT broker → backend | 1 | false | ONLINE/OFFLINE, session_id, timestamp; LWT không có timestamp phải được đối chiếu phiên để tránh offline nhầm phiên mới |
| `/command` | backend → CONTROL_NODE | 1 | false | command_id, shadow_version, desired_state `{light,fan}`, timestamp |
| `/ack` | CONTROL_NODE → backend | 1 | false | command_id, status SUCCESS/FAILED, shadow_version, reported_state, error_code tùy chọn |
| `/reported` | CONTROL_NODE → backend | 1 | false | shadow_version, reported_state, timestamp |
| `/config` | backend → cả hai loại node | 1 | false | config_id, version, settings, timestamp |
| `/config/ack` | cả hai loại node → backend | 1 | false | config_id, version, status SUCCESS/FAILED, error_code tùy chọn |

Backend dùng client ID ổn định, phiên bền vững và subscribe lại khi cần; không enqueue lệnh điều khiển khi broker không sẵn sàng. Không retain command để tránh thực thi lệnh cũ sau reconnect. QoS MQTT không thay thế ACK nghiệp vụ.

Command/ACK/reported đều có session_id; command thêm expires_at (UTC mili giây). Firmware phải bỏ lệnh sai phiên/hết hạn, chống thực thi lặp command_id nhưng vẫn ACK lại. ACK SUCCESS phải kèm reported_state khớp các actuator được yêu cầu. Reported hỗ trợ ON/OFF/UNKNOWN; desired chỉ ON/OFF. Status ONLINE có thể kèm cặp shadow_version/reported_state để đồng bộ relay sau reconnect; không có snapshot thì trạng thái thực giữ UNKNOWN.

Ví dụ bản tin có thể parse được nằm trong [mqtt-examples.json](contracts/mqtt-examples.json). Hai trạng thái ACK lưu telemetry và ACK thực thi command là hai luồng riêng.

## HTTP

- `Authorization: Bearer <JWT>`; JWT chứa `sub`, `ver`, `exp`; quyền và trạng thái người dùng đọc lại từ database cho mỗi request. Logout/đổi mật khẩu/khóa/đổi quyền tăng token version.
- Thành công: `{ "success": true, "data": ... }`; danh sách thêm `meta: {page,page_size,total}`. Thời gian HTTP dùng ISO 8601 UTC. BIGINT ID serialize thành chuỗi để tránh mất độ chính xác JavaScript.
- Lỗi: `{ "success": false, "error": {"code":"...","message":"..."}, "request_id":"..." }`. Không trả stack/SQL/secret. HTTP 400 đầu vào, 401 phiên, 403 quyền, 404 không tồn tại/ngoài phạm vi theo chính sách, 409 xung đột, 429 giới hạn, 503 dependency lỗi.
- `X-Request-Id`: dùng giá trị client nếu khớp bộ ký tự an toàn và <=64 ký tự, nếu không sinh UUID; trả lại header và dùng trong log.
- Danh sách dùng `page>=1`, `1<=page_size<=100`, mặc định 20; lọc/sort phải nằm trong allowlist, SQL dùng parameters.
- CORS theo allowlist cấu hình, không mở wildcard kèm credential. Body JSON HTTP tối đa 32 KB.
- Idempotency-Key cho command: tối đa 64 ký tự, gắn với người gọi và thiết bị trong 60 giây; cùng khóa khác payload trả 409. Không tự retry command mới khi chưa biết kết quả lệnh cũ.

| Mã BE | Endpoint dự kiến | Quyền |
| --- | --- | --- |
| 01/02 | GET `/health`, `/ready` | public, chỉ trạng thái tối thiểu |
| 03 | POST `/auth/login`, `/auth/logout`, `/auth/change-password`; GET `/auth/me` | login public; còn lại đã xác thực |
| 04 | GET/POST `/users`; GET/PATCH `/users/:id` | ADMIN |
| 05 | GET/POST `/rooms`; GET/PATCH `/rooms/:id`; PUT `/rooms/:id/users` | xem theo phạm vi; sửa/gán chỉ ADMIN |
| 06/07 | GET/POST `/devices`; GET/PATCH `/devices/:id`; POST `/devices/:id/{provision,activate,maintenance,recover,revoke,decommission,rotate-credentials}` | xem theo phạm vi; thay đổi chỉ ADMIN |
| 08/14 | GET `/devices/:id/telemetry`, `/rooms/:id/telemetry`, `/rooms/:id/telemetry/latest`, `/rooms/:id/telemetry/export` | mọi vai trò trong phạm vi |
| 10 | POST/GET `/devices/:id/commands`; GET `/devices/:id/shadow` | đọc theo phạm vi; tạo ADMIN/OPERATOR |
| 11 | GET/POST `/devices/:id/configs` | đọc theo phạm vi; thay đổi ADMIN |
| 12 | GET `/alerts`; POST `/alerts/:id/acknowledge`, `/alerts/:id/resolve`; GET/PUT `/rooms/:id/alert-thresholds` | đọc theo phạm vi; xử lý ADMIN/OPERATOR; cấu hình ADMIN |
| 13 | GET/POST `/rooms/:id/automation-rules`; PATCH `/automation-rules/:id` | đọc theo phạm vi; thay đổi ADMIN |
| 14 | GET `/dashboard`; WebSocket `/ws` | scope theo user_rooms; snapshot qua HTTP khi reconnect |
| 15 | GET `/audit-logs`, `/devices/:id/lifecycle-events` | audit ADMIN; lifecycle theo phạm vi |

WebSocket xác thực bằng frame đầu tiên trong thời hạn ngắn, không đưa JWT vào URL/log; không phát dữ liệu trước xác thực. Kiểm tra lại quyền và token version trong vòng đời kết nối. Server chỉ phát event thuộc phòng được cấp quyền.

## Trạng thái và trách nhiệm

- User: ACTIVE / DISABLED; room: ACTIVE / INACTIVE; không hard-delete lịch sử.
- Device lifecycle theo bảng 9.4: REGISTERED → PROVISIONED hoặc DECOMMISSIONED; PROVISIONED → ACTIVE hoặc REVOKED; ACTIVE → FAULT/MAINTENANCE/REVOKED; FAULT → ACTIVE/MAINTENANCE/REVOKED; MAINTENANCE → ACTIVE/REVOKED; REVOKED → PROVISIONED/DECOMMISSIONED; DECOMMISSIONED là kết thúc. Không decommission trực tiếp thiết bị đã provision, phải revoke trước. Khôi phục dùng `/resume` hoặc `/clear-fault`, `/recover` là alias; cần heartbeat mới và phòng hoạt động. Kích hoạt/provision/revoke cần credential và broker ở BE-07.
- Điều chỉnh ràng buộc DB từ bản thiết kế: DECOMMISSIONED được phép không có room_id khi thiết bị bị ngừng sử dụng ngay từ REGISTERED chưa gán phòng, phù hợp transition C10. Các trạng thái đang vận hành vẫn bắt buộc có phòng.
- Connection: UNKNOWN / ONLINE / OFFLINE, độc lập lifecycle; heartbeat 10 giây, timeout HEARTBEAT_TIMEOUT_S mặc định 30 giây, quét mỗi 5 giây. Quét cả PROVISIONED/MAINTENANCE để hiển thị kết nối chính xác; cảnh báo mất kết nối chỉ cho ACTIVE/FAULT ở BE-12. Duplicate/uptime lùi và phiên đã đóng không làm mới last_seen; session mới phải có timestamp mới hơn session đang biết. ONLINE status không thay thế heartbeat để activate/resume.
- Alert: OPEN → ACKNOWLEDGED → RESOLVED; tự phục hồi cũng có thể đóng OPEN. Chỉ một alert chưa resolved mỗi (device,type); ưu tiên CRITICAL; clear sau 3 mẫu mới liên tiếp qua ngưỡng phục hồi.
- Config: PENDING → SUCCESS / FAILED / TIMEOUT; version tăng, trạng thái cuối bất biến.
- Audit: chỉ thêm; actor USER/DEVICE/SYSTEM, action, target, result SUCCESS/FAILURE/DENIED, request_id, thời gian; không lưu credential/password/token. Nghiệp vụ quan trọng và audit cùng transaction.

## Ma trận yêu cầu và kiểm thử

| Yêu cầu đề bài | Mã triển khai | Kịch bản kiểm chứng |
| --- | --- | --- |
| 4.4a, 4.5 người dùng, bảo mật | BE-03–05 | token hết hạn, logout, khóa user, truy cập chéo phòng, Viewer gửi command |
| 4.4b vòng đời thiết bị | BE-06–07,11 | chuyển sai trạng thái, credential riêng, rotate/revoke phiên đang mở, config ACK |
| 4.4c dữ liệu IoT | BE-08,14 | DB lỗi không ACK; trùng đồng thời; xung đột payload; backfill; thiếu occupancy legacy |
| 4.4d cảnh báo/giám sát | BE-09,12,14 | ngắt mạng, reconnect, LWT cũ, ngưỡng và tự đóng, scope realtime |
| 4.4e điều khiển | BE-10 | publish lỗi, ACK sai ID, timeout/restart, ACK muộn/trùng/sai version |
| 4.5 audit và bí mật | BE-01–16 | transaction rollback khi audit lỗi; ACL sai topic; không lộ secret trong log/HTTP |
| nâng cao shadow/offline/rule | ADV-01/02 + BE-08,10,13 | desired khác reported; replay telemetry không điều khiển; manual override/cooldown |
| 7,8 đóng gói và bằng chứng | BE-16 | clone sạch, migrate/seed, restart, backup restore, đo độ trễ, ESP32 thật |

Tài liệu kỹ thuật chính thức: [Express](https://expressjs.com/en/5x/api/), [node-postgres transaction](https://node-postgres.com/features/transactions), [MQTT.js](https://github.com/mqttjs/MQTT.js), [ws](https://github.com/websockets/ws). Các module cũ được giữ làm nền tảng; khác biệt được xử lý ở adapter thay vì thay đổi firmware đang dùng mà không có lộ trình.
