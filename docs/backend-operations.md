# Vận hành và kiểm chứng backend

## Khởi động từ clone mới

Cần Git, Node.js 24 (CI cũng chạy unit trên 22), Docker Engine/Desktop và Docker Compose có hỗ trợ healthcheck/depends_on. Chạy tại thư mục gốc:

```powershell
git clone https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh.git
cd IoT_He_thong_phong_hoc_thong_minh
npm ci
npm run setup:local
docker compose --env-file .env -f deployment/compose.yml --profile app up -d --build --wait backend
npm run smoke
```

Backend ở http://127.0.0.1:3000; Admin lấy từ ADMIN_USERNAME/ADMIN_PASSWORD trong `.env`. Không chạy lại setup nếu đã có `.env`: giữ secret và mật khẩu volume hiện có. Init container dùng tài khoản owner để migrate/checksum, sau đó seed Admin và bootstrap ACL. Backend chỉ có tài khoản database runtime; không được cấp MIGRATION_DATABASE_URL hoặc ADMIN_PASSWORD. Ảnh chạy user node, filesystem chỉ đọc, drop capabilities và không chứa `.env`, PDF hoặc `.git`.

Compose đợi PostgreSQL/Mosquitto healthy và init hoàn thành trước khi mở backend theo [cơ chế depends_on](https://docs.docker.com/compose/how-tos/startup-order/). `/ready` kiểm tra phiên bản migration, database, subscription MQTT và listener realtime. `/health` chỉ là liveness. Seed lặp không đặt lại mật khẩu tài khoản có sẵn. Init thất bại thì backend không khởi động; xem log init để xác định loại lỗi, không in `.env` hoặc `docker compose config` có giá trị secret.

Khi cập nhật mã: build lại và chạy cùng lệnh `up -d --build --wait backend`; migration mới phải thêm file SQL, không sửa file đã áp dụng. Nếu chạy `npm start` ngoài Docker, dừng service backend để tránh trùng cổng và MQTT client ID. BACKEND_PORT/POSTGRES_PORT/MQTT_PORT có thể đổi cổng host; URL nội bộ container giữ nguyên. MQTT_CLIENT_ID phải riêng cho mỗi backend đang kết nối.

## Kiểm thử và demo mô phỏng

```powershell
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db-test mqtt-test
npm run mqtt:bootstrap:test
npm test
npm run test:integration
npm run check:stack
```

`check:stack` cần bộ app đang chạy. Nó kiểm tra login/dashboard/audit/logout, tạo phòng và hai node **mô phỏng** có tên rõ ràng, provision/heartbeat/activate, telemetry → cảnh báo, command → ACK, config → ACK, rồi revoke/decommission node và ngừng phòng. Giữ lịch sử để đối chiếu; mỗi lần chạy tạo phòng mới. Tiếp theo tạo backup, kiểm checksum/restore riêng, graceful stop/start backend và smoke lại. Không kết nối hoặc tác động relay thật. `npm run demo:backend` chỉ chạy luồng mô phỏng; `npm run smoke` dùng Admin và logout tất cả phiên của tài khoản đó. Có thể chọn BASE_URL khi đổi cổng.

Integration dùng database `_test`, schema và tài khoản broker ngẫu nhiên riêng. `entrypoint.test.js` thực sự spawn `server.js`, chạy job nền, kiểm tra automation/ACK/config/WebSocket, restart giữa lúc command PENDING, chờ TIMEOUT và revoke phiên MQTT. Các test khác kiểm tra DB rollback/no ACK, ACL, token giả/hết hạn, cross-room, Viewer, retry/idempotency, ACK sai phiên/sai thứ tự và audit bất biến. CI chạy unit 22/24, integration 24 và một job Docker độc lập có backup/restore/graceful restart.

## Backup và diễn tập restore

```powershell
npm run ops:backup
# Dùng đường dẫn .dump được lệnh trên trả về:
npm run ops:restore-check -- deployment/backups/smartclass-<timestamp>-<id>.dump
```

Backup dùng [pg_dump custom format](https://www.postgresql.org/docs/17/app-pgdump.html), có SHA-256/size trong manifest `.dump.json`, lưu trong `deployment/backups/` bị Git bỏ qua. Đây là **backup database**, chứa dữ liệu và hash nhạy cảm; chỉ lưu trong kho riêng có mã hóa và quyền truy cập phù hợp. `restore-check` kiểm checksum, dùng [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) vào database mới `smartclass_restore_<random>`, đọc lại số bản ghi/schema, kiểm quyền runtime và trigger audit, rồi chỉ xóa database diễn tập vừa tạo. Không restore đè database ứng dụng. Nó cần cả `.dump` và manifest cùng thư mục.

Backup thảm họa đầy đủ còn cần `.env`/DEVICE_SECRET_KEY và volume Mosquitto. Để lấy bộ nhất quán, dừng backend và mqtt, chụp database cùng thư mục `/mosquitto/data/` của container mqtt đang dừng, sau đó bật mqtt/backend trở lại. Có thể dùng `docker compose ... ps -a -q mqtt` lấy ID rồi `docker cp <id>:/mosquitto/data/. <thư-mục-backup-riêng>`; không đưa các file này vào Git. Không chỉ chép file đang ghi. Giữ nguyên DEVICE_SECRET_KEY để giải mã broker operation còn chờ; giữ JWT_SECRET nếu muốn duy trì phiên, hoặc chủ động đổi để logout toàn bộ sau sự cố.

Khôi phục thật vào **project/volume mới**: dựng riêng db, tạo container mqtt nhưng chưa start; restore dump vào database rỗng bằng pg_restore, chép lại broker data vào volume mqtt; khôi phục `.env` tương ứng; start mqtt rồi chạy init/backend. Chọn project name và cổng host mới trong lúc diễn tập để không đụng hệ thống đang chạy. Start script sửa quyền sở hữu broker data. Kiểm readiness, số bản ghi, login, scope, MQTT credential/version và một command/ACK mô phỏng trước khi chuyển lưu lượng. Không dùng `down -v` với volume đang chứa dữ liệu cần giữ. Database restore đã được kiểm chứng tự động; phục hồi cả broker/ESP32 trên hạ tầng đích vẫn cần diễn tập riêng.

## Retention và restart

Retention mặc định tắt. Đặt RETENTION_ENABLED=true để quét khi khởi động và mỗi giờ: mặc định sensor 90 ngày theo recorded_at, event 7 ngày theo created_at, tối đa 1000 hàng mỗi loại mỗi lượt; lần sau tiếp tục. `npm run db:retention` chủ động chạy một lượt với cấu hình hiện tại. EVENT_RETENTION_DAYS không lớn hơn SENSOR_RETENTION_DAYS. Login/API counters và idempotency hết hạn được dọn sau một ngày. Audit, lifecycle, command/config/alert/rule history được giữ; không có job xóa nhật ký. Mỗi lần xóa dữ liệu có audit cùng transaction, lỗi audit thì rollback. Backup trước khi giảm thời gian lưu nếu cần giữ lịch sử lâu hơn.

SIGTERM/SIGINT đóng WebSocket, dừng HTTP nhận mới, chờ job đang chạy, dừng MQTT và trả connection database. Compose cho 15 giây, HTTP grace 10 giây. `check:stack` kiểm log server.stopped trước khi start lại; lệnh/telemetry/audit giữ trên PostgreSQL, broker credential trên volume. Command/config chưa publish được khôi phục bằng cùng ID; quá hạn được kết thúc thay vì gửi lệnh cũ.

## Mạng và firmware

Mặc định mọi cổng host chỉ bind loopback; phù hợp dev/demo tại máy. Để ESP32 truy cập LAN/production, cấu hình DNS/IP, chứng chỉ TLS và firewall trước khi mở cổng. Có [mẫu Mosquitto TLS](../deployment/mosquitto/mosquitto.tls.conf.example): mount thành mosquitto.conf, mount ca/server cert/key ở /mosquitto/certs, publish 8883 và cho firmware xác minh CA/hostname. Backend có thể tiếp tục dùng 1883 trong mạng Docker riêng. Không mở listener nội bộ 1883 ra Internet. Mẫu TLS cần chứng chỉ của môi trường đích; chưa chạy nghiệm thu TLS tại đây.

HTTP/WebSocket production đặt sau reverse proxy HTTPS/WSS: forward HTTP tới loopback 3000, `/ws` cần Upgrade/Connection và HTTP/1.1, timeout đủ cho ping/pong. Đặt CORS_ORIGINS thành origin frontend thực tế. Mặc định không tin X-Forwarded-For; nếu muốn lấy IP người dùng qua proxy thì cấu hình Express trust proxy đúng phạm vi proxy, không tin mọi nguồn.

Firmware cần MQTT username/password/client ID riêng từ provision; tạo session_id mới mỗi CONNECT, heartbeat theo chu kỳ ≤ timeout/3, LWT OFFLINE đúng phiên. Telemetry phải theo [hợp đồng](backend-contracts.md); chờ ACK STORED mới xóa hàng đợi offline. Control Node kiểm session_id/expires_at, chống lặp command_id, chỉ ACK SUCCESS sau khi relay thực thi; gửi reported snapshot thật khi reconnect. Config áp dụng nguyên tử, chống lặp config_id/version và ACK applied settings. Ví dụ firmware offline hiện có cần được ghép các phần auth/heartbeat/config này trước nghiệm thu thiết bị.

## Tài liệu API và giới hạn nghiệm thu

[openapi.json](openapi.json) theo [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) mô tả 53 HTTP operations, Bearer auth, input/query/response envelope và mã lỗi. Tái sinh bằng `npm run docs:openapi`; unit test đối chiếu với toàn bộ route Express và kiểm các schema reference. MQTT/WebSocket và chính sách nghiệp vụ chi tiết nằm trong README/hợp đồng; frontend lấy snapshot khi reconnect.

Backend chạy và được kiểm chứng với PostgreSQL/Mosquitto thật cùng MQTT client Node mô phỏng. Chưa có ESP32/cảm biến/relay thật, frontend tích hợp, chứng chỉ production hoặc bài đo tải/đường truyền Wi-Fi. Giới hạn hiện tại: một Sensor và một Control Node chưa thu hồi mỗi phòng; job quét tối đa 1000 thiết bị/phòng có rule mỗi lượt, consumer cảnh báo tối đa 100 event/lượt. Cần đo tải, phân trang worker hoặc tăng năng lực trước khi dùng quy mô lớn hơn. Chưa tạo tag `v1.0.0` vì tiêu chí nghiệm thu toàn hệ thống trong kế hoạch còn phần phần cứng/frontend.
