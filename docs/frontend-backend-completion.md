# Hoàn thiện frontend theo backend

Nhánh: `feat/frontend-backend-completion`.

Các trường hợp biên phát hiện sau đợt này được xử lý trên nhánh `fix/frontend-backend-contract-edge-cases`; xem [bản sửa bổ sung](frontend-backend-edge-cases.md).

## Phạm vi đã xử lý

| Nhóm thiếu hoặc lệch hợp đồng | Thay đổi |
|---|---|
| Query rỗng, mất meta, giới hạn 20 bản ghi | Lớp resource bỏ tham số trống, giữ false/0, đọc meta; phân trang danh sách và tải đủ các trang cho bộ chọn |
| Ngừng sử dụng thiếu xác nhận; đăng ký chưa gán phòng bị 400 | Form xác nhận gửi boolean thật; đăng ký bỏ room_id rỗng, cập nhật dùng null để gỡ gán đúng hợp đồng |
| Telemetry bị cố định thời gian, biểu đồ sai thứ tự | Tính lại cửa sổ khi tải; thứ tự đo tăng dần cho biểu đồ; khoảng ngày/giờ, thống kê và CSV; xử lý lỗi xuất CSV |
| Bất thường dùng sai trường | Đọc findings lồng nhau, không làm mất giá trị 0; phân biệt bình thường/bất thường, baseline, analyzed_at/recorded_at |
| Điều khiển nhầm ACK hoặc dùng trạng thái thiết bị cũ | Query theo device_id; theo dõi command_id chính xác; khóa gửi khi đang chờ; polling kết quả và retry cùng Idempotency-Key; không tự thay trạng thái báo về |
| Phòng học thiếu chỉnh sửa/phạm vi | Tạo/sửa/trạng thái, đọc và thay thành viên Operator/Viewer đang hoạt động; backend thu hồi phiên theo thay đổi phạm vi |
| Thiết bị thiếu vòng đời/cấu hình | Thông tin đăng ký, gán phòng, thao tác vòng đời, credential đầy đủ và trạng thái broker; lịch sử thật có bộ lọc và phân trang; cấu hình mong muốn/đã áp dụng theo ACK |
| Cảnh báo thiếu thao tác và ngưỡng | Chi tiết, acknowledge, resolve có lý do, các bộ lọc, xem ngưỡng và Admin chỉnh sửa 4 mức ngưỡng |
| Tự động hóa chỉ hiển thị | Tạo/sửa/bật/tắt; trình dựng điều kiện AND/OR, hold/cooldown/priority, chọn Control Node; chế độ AUTO/MANUAL |
| OTA chưa có quy trình đầy đủ | Upload binary, metadata tiếng Việt, publish/revoke có xác nhận, kiểm tra loại node/phần cứng trước khi tạo job, hiển thị tiến trình/lỗi/phiên bản trước |
| Thiếu Monitoring/Audit | Snapshot thật, các bộ lọc log, metadata; lỗi từng phần không làm trắng toàn bộ màn hình |
| Phân quyền menu/route chưa khớp | Viewer xem shadow/lịch sử điều khiển, quy tắc, firmware và OTA trong phòng được giao; thao tác ghi theo ma trận quyền backend; Monitoring/Audit/Users chỉ Admin; xóa cache khi đổi token hoặc phiên bị thu hồi |
| Chuông cảnh báo và WebSocket | Đếm cảnh báo OPEN từ meta.total; invalidation theo loại sự kiện, gộp đợt cập nhật; xác thực và kết nối lại |
| Mock gọi nhầm API thật hoặc mất cập nhật | Resource mock dùng chung trạng thái, sao chép response để cache nhận thay đổi; các thao tác CRUD/firmware/lệnh được mô phỏng cục bộ; không giả ACK phần cứng |
| Mã màn hình cũ và bundle lớn | Chia thành các screen, dùng helper form/bảng/phân trang; bỏ màn hình/helper API thừa; lazy-load theo route và tách chart |

## Điều chỉnh backend cần thiết

- Device DTO trả thêm `control_mode` để giao diện hiển thị đúng AUTO/MANUAL.
- Upload firmware hỗ trợ tùy chọn metadata percent-encoded UTF-8; header cũ vẫn hợp lệ, mã hóa lỗi trả 400.
- Sửa lỗi PostgreSQL `42P08` khi cập nhật trạng thái OTA bằng ép kiểu rõ ràng cho tham số. Trước đó thao tác tạo job từ UI trả 500.
- Không thay schema, mật khẩu, dữ liệu seed hoặc cấu hình `.env` của người dùng.

## Kiểm chứng

- Unit/service/contract: 71 kiểm thử.
- Integration PostgreSQL/MQTT: 101 kiểm thử, gồm regression metadata Unicode và job OTA qua MQTT đến SUCCESS.
- TypeScript và production build cho cả chế độ thật và mock.
- Chrome với backend thật: Dashboard/WebSocket, phòng và thành viên, đăng ký chưa gán/ngừng thiết bị, telemetry mới/CSV, cảnh báo/ngưỡng, anomaly findings, tạo rule, đúng command ACK, cấu hình/ACK, monitoring, firmware/job OTA, phân trang hơn 100 phòng và chi tiết thiết bị ngoài trang đầu, quyền Viewer.
- Chrome với mock: tạo phòng/thiết bị, ngừng sử dụng, acknowledge, upload/publish firmware, timeout lệnh không đổi reported state và không có HTTP đến backend thật.

Lệnh chạy lại được ghi trong [frontend/README.md](../frontend/README.md). Client MQTT trong kiểm thử mô phỏng protocol của thiết bị; chưa xác minh nạp flash và relay trên ESP32 thật.
