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

| Tài khoản | Mật khẩu | Vai trò |
|---|---|---|
| admin | Smart@123456 | ADMIN |
| operator | Smart@123456 | OPERATOR |
| viewer | Smart@123456 | VIEWER |

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
