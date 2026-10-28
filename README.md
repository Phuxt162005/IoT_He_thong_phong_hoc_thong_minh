# Hệ thống phòng học thông minh — Backend

Backend Node.js theo module cho quản lý người dùng, phòng học, thiết bị và dữ liệu IoT. Xem [kế hoạch](docs/backend-implementation-plan.md), [hợp đồng API/MQTT](docs/backend-contracts.md) và [tiến độ](docs/backend-progress.md).

## Chạy cục bộ

Cần Node.js >=20; CI kiểm tra Node.js 22 và 24. Từ thư mục gốc:

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Ứng dụng mặc định nghe tại `http://127.0.0.1:3000`. Sửa `.env` để thay host/port/CORS; không commit thông tin bí mật. Có thể dùng `npm run dev` để tự tải lại khi sửa code.

- `GET /health`: ứng dụng đang hoạt động.
- `GET /ready`: dependency sẵn sàng; BE-01 chưa nối database/broker, các mốc sau bổ sung kiểm tra thực tế.
- Các API nghiệp vụ sẽ xuất hiện theo tiến độ BE, không coi danh mục hợp đồng là danh mục đã triển khai.

## Kiểm thử

```powershell
npm test
npm run test:device-shadow
npm run test:telemetry-ingestion
npm run test:monitoring-logging
```

Test hiện tại gồm service và HTTP bootstrap; chưa thay thế kiểm thử tích hợp PostgreSQL/MQTT/ESP32. GitHub Actions chạy kiểm thử trên mỗi PR và nhánh tính năng.

## Cấu trúc

`backend/src/app.js` tạo Express app không tự mở cổng, `server.js` là entrypoint; `modules/` giữ nghiệp vụ, `common/` giữ lỗi và tiện ích dùng chung. Logger JSON có sẵn từ ADV-03 được tái sử dụng; không ghi request body/header/URL có token vào log. Dữ liệu và credential thật không lưu trong Git.
