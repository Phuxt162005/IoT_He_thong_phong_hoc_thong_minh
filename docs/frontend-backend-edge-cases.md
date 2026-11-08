# Sửa các trường hợp biên frontend/backend

Nhánh: `fix/frontend-backend-contract-edge-cases`.

| Điểm lệch đã tái hiện | Cách xử lý |
|---|---|
| Retry sau khi cache idempotency 60 giây hết hạn có thể tạo lệnh mới | Frontend chỉ cho gửi lại trong 55 giây từ lần đầu, dùng đồng hồ monotonic và giữ nguyên key; hết hạn chuyển sang kiểm tra lịch sử, không tự gửi yêu cầu mới |
| Ghi chú firmware tiếng Việt 2.000 ký tự trả 431 do header percent-encoding quá dài | Frontend dùng Base64 UTF-8; backend kiểm tra mã hóa chặt chẽ và vẫn nhận percent-encoding/ASCII cũ |
| Dashboard đang mở không tự báo số đo hết hạn | Backend trả `fresh_until`; giao diện tính tuổi dữ liệu theo thời gian server, cập nhật mỗi giây mà không gọi API mỗi giây; sự kiện trạng thái thiết bị cũng làm mới snapshot |
| Phòng INACTIVE vẫn bật nút điều khiển | Dùng chung điều kiện phòng ACTIVE, vòng đời hợp lệ, ONLINE và broker SYNCED cho điều khiển/cấu hình/OTA; backend tiếp tục kiểm tra phiên, credential và heartbeat ngay khi thực hiện |
| Thiết bị DECOMMISSIONED vẫn có nút sửa | Ẩn thao tác sửa trên danh sách và trang chi tiết; giữ khả năng đọc dữ liệu, lịch sử |
| Không xem được lịch sử lệnh của thiết bị đã thu hồi | Bộ chọn Control Node giữ cả thiết bị đã thu hồi/ngừng sử dụng, cho xem nhưng khóa thao tác ghi; trang chi tiết có liên kết trực tiếp tới lịch sử đúng thiết bị/phòng |
| Form heartbeat cho tối đa 60 giây trong khi timeout mặc định chỉ cho 10 | API cấu hình trả giới hạn theo timeout đang chạy; form nhận giới hạn đó, không hardcode 60 giây |
| Thống kê mock bỏ qua thời gian và bucket | Lọc khoảng [from,to), loại clock_skew, gộp UTC theo giờ/ngày, tính trung bình/min/max và số mẫu hiện diện |
| UI tạo cây điều kiện nông hơn backend | Đồng bộ giới hạn độ sâu 4 với backend; giữ giới hạn tổng 20 nút |
| Nhãn hiện diện 0/1 nhưng biểu đồ thống kê dùng % | Đổi nhãn, trục và tooltip thành phần trăm khi xem thống kê; dữ liệu từng mẫu vẫn dùng 0/1 |

Không cần migration. Các trường API mới (`fresh_until`, `limits`) là phần bổ sung; client cũ có thể tiếp tục đọc dữ liệu như trước. Backend vẫn là nơi quyết định quyền và khả năng thực hiện tại thời điểm gửi yêu cầu, vì trạng thái thiết bị có thể đổi sau khi tải form.

## Kiểm chứng

- 71 unit/service/contract và 103 integration test PostgreSQL/MQTT.
- Build TypeScript/production cho backend thật và mock.
- Chrome thực hiện toàn bộ luồng chính và hồi quy: cảnh báo dữ liệu cũ tự xuất hiện, mất phản hồi lệnh rồi chặn retry quá hạn, metadata Unicode đủ 2.000 ký tự, giới hạn heartbeat, phòng INACTIVE, thiết bị DECOMMISSIONED và lịch sử sau revoke.
- Chrome mock kiểm tra khoảng thời gian rỗng không còn biểu đồ sai, gộp mẫu theo ngày, nhãn hiện diện %, dữ liệu thay đổi cục bộ và không gọi backend thật.

Chạy lại các lệnh trong [frontend/README.md](../frontend/README.md). Kiểm thử dùng MQTT client mô phỏng và database riêng; chưa kiểm chứng relay/nạp firmware trên ESP32 thật.

## Vì sao xuất hiện “Simulated”?

Phiên bản cũ của `deployment/scripts/demo-backend.mjs` đặt tên phòng **BE-16 simulated backend verification**, tạo hai thiết bị **Simulated SENSOR_NODE/CONTROL_NODE**, gửi mẫu **36°C / 65% / 250 lux** qua MQTT để kiểm tra backend. Script giữ lịch sử sau khi kết thúc. Vì vậy các tên và số đo đó có thể xuất hiện khi frontend đang kết nối database thật.

Script hiện dùng tên **Phòng học A101**, **Cảm biến môi trường A101**, **Bộ điều khiển đèn, quạt A101** (số phòng theo ID), hoặc tên phòng đặt bằng `DEMO_ROOM_NAME`. Các bản ghi cũ trong môi trường cục bộ được đổi nhãn sang A101–A103 bằng transaction có audit `ROOM_DEMO_RENAME`/`DEVICE_DEMO_RENAME`; mã, trạng thái và dữ liệu lịch sử giữ nguyên.

Hệ thống không tự thêm chữ “Simulated” khi thiếu phần cứng. Đổi tên không cần ESP32; số đo mới và trạng thái thực tế cần thiết bị gửi heartbeat/telemetry hợp lệ. Các mẫu cũ vẫn là dữ liệu chạy thử. Xem [giải thích cho người chạy ứng dụng](../frontend/README.md#tên-phòng-thiết-bị-và-dữ-liệu-chạy-thử).
