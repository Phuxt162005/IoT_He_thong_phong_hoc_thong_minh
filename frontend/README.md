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

Mock giữ cùng các kiểu dữ liệu chính của API (`rooms`, `devices`, `telemetry/latest`, `alerts`, `commands`, `users`, `audit-logs`). Khi tích hợp backend, các response list có thể bọc `meta` theo hợp đồng.
