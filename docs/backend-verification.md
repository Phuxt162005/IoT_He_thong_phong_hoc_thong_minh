# Kiểm chứng backend BE-00–16

Môi trường kiểm chứng cục bộ: Windows/Docker Desktop, Node.js 24, PostgreSQL 17 và Mosquitto Dynamic Security. Dữ liệu MQTT đến từ client Node mô phỏng. Các kết quả dưới đây là kết quả chạy thực tế; chưa đại diện cho phần cứng hoặc production.

BE-16 đã tích hợp qua [PR #17](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/17), merge `395e016`. [CI nhánh](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/actions/runs/40731900813) và [CI Pull Request](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/actions/runs/40731925068) đều đạt cả unit, integration và deployment. Clone sạch nhánh từ GitHub, cài `npm ci` và chạy lại đủ 119 test cũng đạt.

| Phạm vi | Bằng chứng |
| --- | --- |
| Unit/service/HTTP/contract | 40/40 test đạt; gồm ADV của nhóm, bootstrap, password, encryption và đối chiếu 53 route OpenAPI. |
| Tích hợp | 79/79 test PostgreSQL/Mosquitto đạt; database/schema/identity riêng; có chạy server entrypoint thật và job nền. |
| Định danh/quyền | JWT giả/hết hạn/logout/khóa/đổi scope, Viewer/Operator, cross-room HTTP/CSV/WebSocket, mật khẩu MQTT sai, client ID/ACL sai, rotate/revoke phiên đang kết nối. |
| Tính bền vững | ACK STORED sau commit, rollback không ACK, unique telemetry đồng thời, restart outbox/command/config/alert/rule, ACK cũ/khác phiên không làm lùi trạng thái. |
| Điều khiển | Desired khác reported cho đến ACK; timeout còn được xử lý sau restart; manual override, hold/cooldown/priority, bỏ qua stale/backfill/replay. |
| Audit | Chỉ Admin tra cứu global; audit/lifecycle append-only tại DB; lỗi audit rollback nghiệp vụ; redaction lồng nhau trước lưu. |
| Realtime | NOTIFY sau commit, first-frame auth, thu hồi phiên, scope, giới hạn kết nối/origin, mất listener đóng socket và reconnect đòi snapshot. |
| Docker | Init migrate/seed/bootstrap hoàn thành, backend non-root/read-only healthy; smoke và demo MQTT qua ảnh Docker đạt. |
| Backup/restore | pg_dump custom + manifest SHA-256; restore vào database ngẫu nhiên riêng, kiểm bản ghi/schema, quyền runtime và trigger rồi dọn database diễn tập. Lần chạy có dữ liệu: 1 user, 3 phòng, 6 thiết bị, 3 telemetry, 111 audit; migration 014. |
| Graceful restart | check:stack xác nhận server.stopped trên Linux container trước start lại; readiness và API đạt sau restart. |

Độ trễ được tính bằng performance.now() ngay trước publish telemetry MQTT đến lúc nhận frame telemetry.stored qua WebSocket. Các lần chạy local đo khoảng 61–65 ms, bao gồm một ca entrypoint thật; đây là loopback và client mô phỏng, chưa có bài tải hoặc Wi-Fi. Không dùng thời gian assertion/polling này để cam kết SLA.

Chạy lại: `npm test`, `npm run test:integration`, `npm run check:stack` theo [hướng dẫn vận hành](backend-operations.md). CI có unit Node 22/24, integration Node 24 và Docker stack riêng; trạng thái chính thức theo Pull Request/Actions trên GitHub. Các ca DB/MQTT dùng service thật, còn relay/config ACK do client mô phỏng gửi.

Nghiệm thu còn lại ngoài backend: ghép firmware auth/heartbeat/config với ESP32, đọc DHT/BH1750/PIR thật, xác nhận relay và lỗi relay, frontend HTTP/WebSocket và cảnh báo, TLS với chứng chỉ đích, ngắt mạng Wi-Fi/offline queue trên thiết bị, diễn tập khôi phục cả broker/hardware, đo tải và độ trễ trên mạng thực tế. Không tạo `v1.0.0` toàn hệ thống khi các mục này chưa có bằng chứng.
