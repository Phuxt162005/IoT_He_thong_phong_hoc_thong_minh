# Hệ thống phòng học thông minh — Backend

Backend Node.js theo module cho quản lý người dùng, phòng học, thiết bị và dữ liệu IoT. Xem [kế hoạch](docs/backend-implementation-plan.md), [hợp đồng API/MQTT](docs/backend-contracts.md) và [tiến độ](docs/backend-progress.md).

## Chạy cục bộ

Cần Node.js >=20 và Docker Desktop đang chạy; CI kiểm tra Node.js 22 và 24. Từ thư mục gốc:

```powershell
npm ci
npm run setup:local
docker compose --env-file .env -f deployment/compose.yml --profile test up -d --wait db db-test
npm run db:migrate
npm run db:seed
npm start
```

`setup:local` tạo `.env` và `.env.test` với mật khẩu ngẫu nhiên, từ chối ghi đè file có sẵn. Nếu đã có cấu hình, đối chiếu `.env.example`/`.env.test.example` và bổ sung thủ công. Không chạy lại setup để thay mật khẩu của volume PostgreSQL đã tồn tại: biến POSTGRES_* chỉ áp dụng khi khởi tạo volume lần đầu.

Ứng dụng mặc định nghe tại `http://127.0.0.1:3000`. Sửa `.env` để thay host/port/CORS; không commit thông tin bí mật. Có thể dùng `npm run dev` để tự tải lại khi sửa code. Tài khoản ban đầu lấy từ ADMIN_USERNAME/ADMIN_PASSWORD trong `.env`; seed không đặt lại mật khẩu người dùng đã tồn tại. Mặc định chỉ tạo Admin; muốn tạo demo_operator/demo_viewer trong môi trường thử nghiệm, đặt SEED_DEMO_USERS=true và DEMO_PASSWORD riêng.

- `GET /health`: ứng dụng đang hoạt động.
- `GET /ready`: kiểm tra truy vấn PostgreSQL thật, trả 503 khi database không sẵn sàng. MQTT được bổ sung ở BE-07.
- Các API nghiệp vụ sẽ xuất hiện theo tiến độ BE, không coi danh mục hợp đồng là danh mục đã triển khai.

## Kiểm thử

```powershell
npm test
npm run test:integration
npm run test:device-shadow
npm run test:telemetry-ingestion
npm run test:monitoring-logging
```

`npm test` chạy unit/service/HTTP. Integration test bắt buộc dùng TEST_DATABASE_URL và TEST_MIGRATION_DATABASE_URL trỏ tới database tên kết thúc `_test`; mỗi test chỉ tạo/xóa schema ngẫu nhiên của riêng nó. Không chạy với database ứng dụng. GitHub Actions có PostgreSQL service riêng và tài khoản ứng dụng không phải superuser. Chưa có kiểm thử MQTT/ESP32 cho tới các mốc tương ứng.

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

## Cấu trúc

`backend/src/app.js` tạo Express app không tự mở cổng, `server.js` là entrypoint; `modules/` giữ nghiệp vụ, `common/` giữ lỗi và tiện ích dùng chung. Logger JSON có sẵn từ ADV-03 được tái sử dụng; không ghi request body/header/URL có token vào log. Dữ liệu và credential thật không lưu trong Git.
