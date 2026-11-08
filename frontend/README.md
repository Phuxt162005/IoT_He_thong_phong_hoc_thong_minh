# Smart Classroom IoT — Web Dashboard

SPA React 18 + Vite + TypeScript cho hệ thống phòng học thông minh. Giao diện tiếng Việt, có responsive layout, light/dark mode và RBAC cho `ADMIN`, `OPERATOR`, `VIEWER`.

## Chạy nhanh

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

Chế độ mock chỉ dùng khi đặt `VITE_USE_MOCK=true`. Cấu hình `.env.example` hiện đã để `VITE_USE_MOCK=false` để frontend kết nối backend thật.

Các tài khoản dưới đây chỉ dùng trong chế độ mock:

| Tài khoản | Mật khẩu | Vai trò |
|---|---|---|
| admin | Smart@123456 | ADMIN |
| operator | Smart@123456 | OPERATOR |
| viewer | Smart@123456 | VIEWER |

## Đăng nhập, đăng ký và quản lý tài khoản

- `/login`: đăng nhập chung cho ba vai trò. Backend xác định vai trò từ database; người dùng không tự chọn quyền. Frontend kiểm tra lại phiên qua `/auth/me`, hiển thị menu và chặn route theo quyền.
- `/register`: họ tên, tên đăng nhập và mật khẩu xác nhận. Tự đăng ký chỉ tạo `VIEWER`, chưa có phòng được gán. Tên đăng nhập gồm 3–64 ký tự chữ/số/`_.-`; mật khẩu 8–128 ký tự. Đăng ký giới hạn 5 lần/IP/15 phút.
- Admin vào **Người dùng** để tạo Operator/Viewer, sửa họ tên, đổi giữa hai quyền, khóa/mở khóa hoặc đặt lại mật khẩu. Danh sách có lọc vai trò, trạng thái và phân trang. Mật khẩu cũ không được hiển thị.
- Tất cả vai trò có thể chọn **Đổi mật khẩu** ở thanh trên. Phải nhập đúng mật khẩu hiện tại; sau khi đổi cần đăng nhập lại.
- Đổi quyền/trạng thái hoặc đặt lại mật khẩu sẽ thu hồi các JWT cũ. Operator/Viewer chỉ truy cập phòng được gán theo cơ chế phạm vi phòng của backend; đăng ký không tự cấp quyền cho các phòng hiện có.
- `ADMIN`: quản lý tài khoản, cấu hình, tự động hóa và audit. `OPERATOR`: giám sát và điều khiển phòng được giao. `VIEWER`: chỉ xem dữ liệu phòng được giao. Backend kiểm tra quyền độc lập với giao diện.
- Ở chế độ mock, tài khoản tạo/sửa chỉ lưu trong bộ nhớ để thử giao diện và mất khi tải lại trang. Dùng `VITE_USE_MOCK=false` để lưu thật vào PostgreSQL.

API bổ sung: `POST /api/v1/auth/register` nhận `{username,password,display_name}`; `POST /api/v1/users/:id/reset-password` chỉ Admin, nhận `{new_password}`. Hai thao tác lưu audit trong cùng transaction với thay đổi tài khoản. Không cần migration mới.

## Kết nối backend và cảm biến

Đặt `VITE_USE_MOCK=false`, sau đó cấu hình `VITE_API_URL=http://localhost:3000/api/v1` và `VITE_WS_URL=ws://localhost:3000/ws`. Lớp API gửi JWT qua `Authorization: Bearer`, dùng `Idempotency-Key` cho command và giữ path theo backend contract. Không truy cập database từ frontend.

Khởi động backend từ thư mục gốc trước khi mở frontend:

```powershell
npm install
npm run setup:local
docker compose --env-file .env -f deployment/compose.yml --profile app up -d --build --wait backend
```

Sau đó cần đăng nhập bằng `ADMIN_USERNAME` và `ADMIN_PASSWORD` trong file `.env` ở thư mục gốc. Cảm biến không thể chỉ cắm là tự xuất hiện: lần đầu phải tạo phòng, đăng ký `device_code`, gán thiết bị vào phòng và provision credential trong màn hình “Thiết bị”. Sau khi firmware ESP32 kết nối MQTT và publish heartbeat/telemetry đúng topic, dữ liệu sẽ tự chảy vào Dashboard qua REST và WebSocket.

Danh sách lấy số trang, tổng bản ghi và khoảng thời gian từ `meta` của backend. Bộ chọn phòng, thiết bị và thành viên tải đủ các trang, kể cả khi có hơn 100 bản ghi. Chế độ mock dùng chung dữ liệu trong bộ nhớ cho các màn hình và không gửi HTTP/WebSocket đến backend thật. Lệnh mock không nhận ACK sẽ timeout; trạng thái phần cứng không tự đổi thành thành công.

## Các màn hình đã kết nối API

| Màn hình | Chức năng |
|---|---|
| Tổng quan | Số đo mới nhất, cảnh báo dữ liệu cũ, thống kê 24 giờ, trạng thái thiết bị, shadow và lịch sử lệnh |
| Phòng học | Tạo/sửa, đổi trạng thái, gán Operator/Viewer, xem chi tiết thiết bị trong phòng |
| Thiết bị | Đăng ký khi chưa có phòng, sửa/gán phòng, provision, kích hoạt, xoay/thu hồi credential, bảo trì/khôi phục/ngừng sử dụng có xác nhận |
| Chi tiết thiết bị | Heartbeat/RSSI/heap/uptime, credential đầy đủ, đồng bộ broker, lịch sử vòng đời và cấu hình mong muốn/đã áp dụng theo ACK |
| Telemetry | Phân trang, lọc phòng/thiết bị/thời gian, thống kê giờ/ngày, hiện diện, CSV, múi giờ máy người dùng |
| Cảnh báo | Lọc, xem chi tiết, xác nhận, đóng với lý do; Admin sửa ngưỡng, các vai trò khác xem ngưỡng |
| Điều khiển | Trạng thái báo về, AUTO/MANUAL, gửi lại cùng Idempotency-Key, theo dõi đúng command_id, lịch sử cả đèn và quạt; Viewer chỉ xem |
| Tự động hóa | Xem quy tắc; Admin tạo/sửa/bật/tắt, điều kiện AND/OR lồng nhau |
| Bất thường | Hiển thị findings, giá trị 0, baseline, thời gian đo/phân tích và chi tiết |
| OTA | Xem firmware và job theo phạm vi phòng; Admin upload/phát hành/thu hồi/tạo yêu cầu cập nhật, theo dõi tiến trình và lỗi |
| Audit / Monitoring | Admin lọc nhật ký, xem metadata, tình trạng hệ thống, bộ đếm và chẩn đoán |

WebSocket làm mới những nhóm dữ liệu liên quan, gộp các sự kiện liên tiếp để hạn chế gọi API. Lệnh điều khiển nhận ACK được xử lý ngay theo mã lệnh; các job OTA đang chạy được kiểm tra lại mỗi 15 giây. Có thể dùng nút cập nhật trên màn hình để đọc lại ngay.

OTA gửi metadata tiếng Việt bằng header `x-metadata-encoding: percent-utf8`; backend vẫn nhận metadata ASCII từ client cũ. Không cần migration database mới. Chi tiết thay đổi và kiểm chứng ở [frontend-backend-completion.md](../docs/frontend-backend-completion.md).

## Kiểm thử giao diện tích hợp

Chạy từ thư mục gốc, sau khi khởi động PostgreSQL/MQTT thử nghiệm và cấu hình `.env.test` theo [hướng dẫn vận hành](../docs/backend-operations.md). Các ca này tạo database riêng và không dùng dữ liệu ứng dụng đang chạy. Cần Chrome; có thể đặt `BROWSER_BIN` nếu Chrome nằm ở vị trí khác.

```powershell
npm test
npm run mqtt:bootstrap:test
npm run test:integration
npm --prefix frontend run build -- --outDir ../.local/frontend-completion-build
node --test tests/frontend-completion.browser.mjs

$env:VITE_USE_MOCK='true'
npm --prefix frontend run build -- --outDir ../.local/frontend-completion-mock
Remove-Item Env:VITE_USE_MOCK
node --test tests/frontend-mock.browser.mjs
```

Hai bộ kiểm thử trình duyệt dùng cổng 5181/5182 và Chrome CDP 9229/9230. Chúng kiểm tra thao tác form, phân trang, phân quyền, lỗi API và chế độ mock không gọi backend thật. Kết quả MQTT trong bộ kiểm thử do client mô phỏng gửi; việc nạp firmware/đóng relay trên ESP32 thật vẫn cần kiểm thử với phần cứng.
