# Hệ thống phòng học thông minh — Backend

Backend Node.js theo module cho quản lý người dùng, phòng học, thiết bị và dữ liệu IoT. Xem [kế hoạch](docs/backend-implementation-plan.md), [hợp đồng API/MQTT](docs/backend-contracts.md) và [tiến độ](docs/backend-progress.md).

## Chạy cục bộ

Cần Node.js >=20 và Docker Desktop đang chạy; CI kiểm tra Node.js 22 và 24. Từ thư mục gốc:

```powershell
npm ci
npm run setup:local
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test mqtt mqtt-test
npm run db:migrate
npm run db:seed
npm run mqtt:bootstrap
npm run mqtt:bootstrap:test
npm start
```

`setup:local` tạo `.env` và `.env.test` với mật khẩu ngẫu nhiên, từ chối ghi đè file có sẵn. Nếu đã có cấu hình, đối chiếu `.env.example`/`.env.test.example` và bổ sung thủ công. Không chạy lại setup để thay mật khẩu của volume PostgreSQL đã tồn tại: biến POSTGRES_* chỉ áp dụng khi khởi tạo volume lần đầu.

Ứng dụng mặc định nghe tại `http://127.0.0.1:3000`. Sửa `.env` để thay host/port/CORS; không commit thông tin bí mật. Có thể dùng `npm run dev` để tự tải lại khi sửa code. Tài khoản ban đầu lấy từ ADMIN_USERNAME/ADMIN_PASSWORD trong `.env`; seed không đặt lại mật khẩu người dùng đã tồn tại. Mặc định chỉ tạo Admin; muốn tạo demo_operator/demo_viewer trong môi trường thử nghiệm, đặt SEED_DEMO_USERS=true và DEMO_PASSWORD riêng.

- `GET /health`: ứng dụng đang hoạt động.
- `GET /ready`: kiểm tra PostgreSQL và kết nối/subscription MQTT thật, trả 503 khi một dependency không sẵn sàng.
- Các API nghiệp vụ sẽ xuất hiện theo tiến độ BE, không coi danh mục hợp đồng là danh mục đã triển khai.

## Kiểm thử

```powershell
npm test
npm run test:integration
npm run test:device-shadow
npm run test:telemetry-ingestion
npm run test:monitoring-logging
```

`npm test` chạy unit/service/HTTP. Integration test bắt buộc dùng TEST_DATABASE_URL và TEST_MIGRATION_DATABASE_URL trỏ tới database tên kết thúc `_test`; mỗi test chỉ tạo/xóa schema ngẫu nhiên của riêng nó. MQTT test dùng broker riêng trên localhost:1885, tài khoản thiết bị ngẫu nhiên và dọn sau test. Không chạy với dịch vụ ứng dụng. GitHub Actions có PostgreSQL/Mosquitto riêng. Chưa thay thế kiểm thử ESP32 thật.

## Database

- PostgreSQL ứng dụng ở localhost:5433; instance kiểm thử riêng ở localhost:5434.
- `database/migrations/` chứa SQL có phiên bản, checksum và advisory lock; sửa schema bằng migration mới, không sửa migration đã áp dụng.
- MIGRATION_DATABASE_URL dùng tài khoản quản lý schema; DATABASE_URL dùng smartclass_app với quyền nghiệp vụ, không có quyền tạo schema hoặc sửa/xóa/truncate audit.
- Nghiệp vụ quan trọng phải dùng cùng connection/transaction với audit. Trigger chặn chỉnh sửa audit kể cả bằng tài khoản sở hữu qua lệnh DML thông thường.
- Lược đồ hiện tại gồm roles/users/rooms/user_rooms/devices/audit_logs; các bảng telemetry/command/rule được thêm ở tính năng tương ứng.
- `docker compose --env-file .env -f deployment/compose.yml stop` dừng dịch vụ và giữ volume dữ liệu ứng dụng. Không dùng lệnh xóa volume nếu muốn giữ dữ liệu.

## Xác thực (BE-03)

Chạy lại `npm run db:migrate` sau mỗi lần cập nhật mã có migration mới. File `.env` có sẵn từ trước BE-03 cần bổ sung JWT_SECRET ngẫu nhiên tối thiểu 32 byte và JWT_EXPIRES_IN=3600; `setup:local` phiên bản mới tạo sẵn hai giá trị này. Không đổi secret khi restart; đổi secret sẽ vô hiệu toàn bộ JWT đã cấp.

| Endpoint | Nội dung |
| --- | --- |
| POST `/api/v1/auth/login` | JSON `{username,password}`; trả `access_token`, `expires_in`, thông tin người dùng an toàn. |
| GET `/api/v1/auth/me` | Header `Authorization: Bearer <access_token>`; kiểm tra chữ ký/hạn token, trạng thái user và token version trong DB. |
| POST `/api/v1/auth/logout` | Có Bearer token; vô hiệu **tất cả phiên** của tài khoản bằng token version. |
| POST `/api/v1/auth/change-password` | Có Bearer token; JSON `{current_password,new_password}`; mật khẩu mới dài 12–128 ký tự, khác mật khẩu cũ; đăng nhập lại sau khi đổi. |

Sau 5 lần đăng nhập sai trong 15 phút theo cặp IP/username, server trả 429 cho tới hết cửa sổ. Bộ đếm lưu trong PostgreSQL nên giữ qua restart với cùng JWT_SECRET. Mặc định không tin X-Forwarded-For; khi triển khai qua reverse proxy cần cấu hình trust proxy theo đúng mạng proxy, tránh cho client tự khai IP. Mật khẩu được băm bằng [scrypt của Node.js](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback); JWT dùng [jose](https://github.com/panva/jose) và chỉ chấp nhận HS256 với issuer/audience cố định. Không lưu token vào URL hoặc log.

## Quản lý người dùng và quyền (BE-04)

Các API dưới đây cần Bearer token của ADMIN. OPERATOR/VIEWER nhận 403; việc từ chối được audit. Không có API xóa người dùng; dùng trạng thái DISABLED để giữ lịch sử.

| Endpoint | Nội dung |
| --- | --- |
| GET `/api/v1/users` | Lọc `role`, `status`; phân trang `page`, `page_size` tối đa 100. |
| POST `/api/v1/users` | JSON `{username,password,display_name,role}`; tạo tài khoản, trả 201; username đã dùng trả 409. |
| GET `/api/v1/users/:id` | Thông tin an toàn, không có hash mật khẩu/token version. |
| PATCH `/api/v1/users/:id` | JSON gồm `display_name`, `role`, `status`; không nhận field ngoài danh sách. |

Đổi vai trò hoặc trạng thái tăng token version, vô hiệu ngay JWT cũ; mở khóa không làm phiên cũ sống lại. Server giữ ít nhất một Admin ACTIVE, kể cả hai Admin tự hạ quyền đồng thời. Mọi API đã xác thực giới hạn 100 yêu cầu trong mỗi cửa sổ 60 giây theo tài khoản; bộ đếm nguyên tử trong PostgreSQL. Login có giới hạn riêng nêu ở BE-03.

Ma trận quyền nằm tại `common/authorization.js`; module tiếp theo dùng cùng kiểm tra quyền và `requireRoomScope` để giới hạn phòng. Các thao tác ghi kiểm tra lại quyền/trạng thái người thực hiện bên trong transaction.

## Phòng học và phạm vi truy cập (BE-05)

| Endpoint | Nội dung |
| --- | --- |
| GET `/api/v1/rooms` | Danh sách phòng trong phạm vi, phân trang, lọc status; Admin thấy tất cả. |
| POST `/api/v1/rooms` | Admin tạo bằng `{room_code,room_name}`; mã ổn định theo hợp đồng MQTT. |
| GET `/api/v1/rooms/:id` | Thông tin phòng và danh sách thiết bị được gán; ngoài phạm vi trả 404. |
| PATCH `/api/v1/rooms/:id` | Admin đổi `{room_name,status}`; INACTIVE giữ lịch sử và thiết bị, không hard-delete. |
| GET/PUT `/api/v1/rooms/:id/users` | Admin đọc/thay toàn bộ thành viên; PUT nhận `{user_ids:["2","3"]}`, tối đa 500 ID duy nhất. |

Chỉ gán Operator/Viewer ACTIVE; Admin luôn có toàn bộ phạm vi nên không cần gán. Gán/bỏ gán phòng tăng token version cho người bị thay đổi phạm vi, yêu cầu đăng nhập lại; gửi lại đúng danh sách hiện có không vô hiệu phiên. Thay đổi và audit nằm cùng transaction. Mã phòng không đổi qua PATCH để giữ ổn định topic thiết bị.

## Thiết bị và vòng đời (BE-06)

| Endpoint | Nội dung |
| --- | --- |
| GET `/api/v1/devices` | Scope theo phòng; lọc room_id, device_type, lifecycle_status, connection_status và phân trang. |
| POST `/api/v1/devices` | Admin đăng ký `{device_code,device_name,device_type,room_id?,hardware_version?,firmware_version?}`. |
| GET `/api/v1/devices/:id` | Thông tin và actuators; Control Node có LIGHT/FAN, trạng thái thực ban đầu UNKNOWN. |
| PATCH `/api/v1/devices/:id` | Admin đổi tên/phiên bản; chỉ gán/bỏ gán phòng khi REGISTERED. Không đổi mã, loại node hoặc trạng thái trực tiếp. |
| POST `/api/v1/devices/:id/maintenance` | ACTIVE/FAULT → MAINTENANCE, body `{reason}`. |
| POST `/api/v1/devices/:id/resume` hoặc `/clear-fault` | MAINTENANCE/FAULT → ACTIVE; cần ONLINE, heartbeat trong 30 giây và phòng ACTIVE. `/recover` là alias chọn theo trạng thái. |
| POST `/api/v1/devices/:id/decommission` | Chỉ REGISTERED/REVOKED → DECOMMISSIONED; body `{reason,confirmed:true}`. |
| GET `/api/v1/devices/:id/lifecycle-events` | Lịch sử chỉ ghi thêm, phân trang và kiểm tra scope. |

BE-06 triển khai các chuyển trạng thái nội bộ. API provision/activate/revoke/rotate cần credential và broker thật, được bổ sung ở BE-07; không thể dùng PATCH để bỏ qua quy trình. Thiết bị PROVISIONED/ACTIVE muốn ngừng sử dụng phải revoke trước. Mỗi phòng có tối đa một node chưa thu hồi cho từng loại; mã thiết bị đã ngừng sử dụng không được tái dùng. Bảo trì không đổi trạng thái kết nối thành OFFLINE; vòng đời và kết nối độc lập.

## Broker và credential thiết bị (BE-07)

Mosquitto ứng dụng ở localhost:1884, broker test ở localhost:1885. Cả hai dùng [Dynamic Security](https://mosquitto.org/documentation/dynamic-security/), từ chối anonymous, ACL mặc định deny; vai trò Sensor/Control chỉ được publish/subscribe topic của mã thiết bị. Tài khoản backend và quản trị broker tách riêng. `mqtt:bootstrap` cấu hình role và tài khoản backend; chạy lại sẽ đồng bộ quyền và ngắt phiên backend đang mở trong lúc cập nhật tài khoản.

| Endpoint | Nội dung |
| --- | --- |
| POST `/api/v1/devices/:id/provision` | Admin, `{reason,confirmed?}`; REGISTERED/REVOKED → PROVISIONED. Cấp lại REVOKED cần confirmed:true. |
| POST `/api/v1/devices/:id/activate` | Admin, `{reason}`; chỉ khi credential đã đồng bộ và nhận heartbeat mới qua MQTT. |
| POST `/api/v1/devices/:id/rotate-credentials` | Admin, `{reason}`; cấp secret mới và ngắt phiên cũ; phải nạp secret mới vào thiết bị. |
| POST `/api/v1/devices/:id/revoke` | Admin, `{reason,confirmed:true}`; chặn backend ngay, disable broker account và ngắt kết nối. |
| GET `/api/v1/devices/:id/broker-status` | Theo phạm vi phòng; trạng thái đồng bộ và lịch sử thao tác đã loại bỏ secret. |

Provision/rotate trả credential **một lần** với username và client_id bằng device_code. Thiết bị phải dùng đúng cả username/password/client ID; firmware ví dụ cũ dùng client ID có boot suffix cần điều chỉnh trước khi kết nối. `session_id` của heartbeat mang boot ID riêng. MQTT URL trong phản hồi lấy từ cấu hình; hiện Compose chỉ mở loopback cho phát triển, chưa dành cho ESP32 truy cập từ LAN.

DB lưu hash scrypt, còn secret cần retry được mã hóa AES-256-GCM và gắn với đúng operation. Khi đồng bộ thành công, bản mã bị xóa; không có API lấy lại secret. Nếu làm mất secret trả về, dùng rotate-credentials. DEVICE_SECRET_KEY là 32 byte hex cần giữ cùng cấu hình khôi phục dữ liệu, không đổi khi restart.

Broker lỗi trả HTTP 202 với operation.status=PENDING, không báo đã áp dụng. Hàng đợi trong PostgreSQL được thử lại nền, kể cả sau restart. Trong lúc chờ, backend không cho activate; revoke đã chặn nghiệp vụ nhưng kết nối broker chỉ bị ngắt sau khi sync thành công. Xem broker-status để phân biệt hai trạng thái. Bản ghi outbox bị thao tác mới thay thế không tiếp tục áp dụng secret cũ.

Môi trường đã tồn tại trước BE-07 cần bổ sung MQTT_* và DEVICE_SECRET_KEY theo `.env.example`, TEST_MQTT_* theo `.env.test.example`. TEST_MQTT_ADMIN_PASSWORD trong `.env` phải trùng `.env.test` cho cùng broker test. Volume broker giữ credential qua restart; đổi mật khẩu trong .env không tự thay admin đã lưu trong volume.

## Telemetry và đồng bộ offline (BE-08)

Server subscribe telemetry theo topic trong [hợp đồng](docs/backend-contracts.md), đối chiếu mã thiết bị/phòng và credential đang hoạt động. Chỉ SENSOR_NODE thuộc phòng ACTIVE với lifecycle ACTIVE/FAULT/MAINTENANCE và broker đã đồng bộ được lưu dữ liệu. PROVISIONED/REVOKED/DECOMMISSIONED bị từ chối; FAULT/MAINTENANCE chỉ giám sát, không được dùng để điều khiển tự động.

- Chấp nhận payload chuẩn và legacy của ADV-02. Kiểm tra nhiệt độ [-10,60] °C, độ ẩm [0,100] %, lux [0,65535]; chuẩn cần lux nguyên/occupancy boolean. Legacy giữ lux thập phân, occupancy thiếu lưu NULL.
- PostgreSQL commit `sensor_data`, `telemetry_latest` và event bền vững trong cùng transaction, sau đó mới gửi ACK STORED. DB lỗi không ACK; retry được lưu lại an toàn khi dịch vụ phục hồi.
- Chống trùng bằng `(device_id,msg_id)` và hash nội dung: cùng bản tin được ACK lại; cùng ID khác nội dung bị từ chối. Các thiết bị khác nhau có thể dùng cùng msg_id.
- Bản tin offline giữ nguyên recorded_at quá khứ. Bản tin cũ hơn latest hoặc quá TELEMETRY_FRESHNESS_S (mặc định 30 giây) chỉ phục vụ lịch sử, không kích hoạt điều khiển. Mẫu thiếu timestamp hoặc vượt tương lai >5 phút được gắn clock_skew, dùng received_at cho lịch sử, không đè latest.
- Năm payload cảm biến không hợp lệ liên tiếp đưa thiết bị ACTIVE vào FAULT; mẫu hợp lệ đặt lại bộ đếm nhưng không tự bỏ trạng thái FAULT. Admin dùng clear-fault sau khi khắc phục.
- `iot_events` và `iot_event_deliveries` giữ dấu vết cho consumer cảnh báo/tự động hóa ở các mốc sau; duplicate không tạo event mới. API tra cứu/CSV/dashboard được bổ sung ở BE-14.

Dynamic Security request nay dùng correlationData riêng, dựa trên [kiểm thử giao thức của Mosquitto](https://github.com/eclipse-mosquitto/mosquitto/blob/master/test/broker/14-dynsec-disable-client.py), để không nhận nhầm phản hồi khi nhiều thao tác quản trị chạy đồng thời.

## Cấu trúc

`backend/src/app.js` tạo Express app không tự mở cổng, `server.js` là entrypoint; `modules/` giữ nghiệp vụ, `common/` giữ lỗi và tiện ích dùng chung. Logger JSON có sẵn từ ADV-03 được tái sử dụng; không ghi request body/header/URL có token vào log. Dữ liệu và credential thật không lưu trong Git.
