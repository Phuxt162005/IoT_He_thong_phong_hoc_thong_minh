# Dọn dữ liệu chạy thử và bố cục đèn/quạt

Nhánh: `fix/remove-demo-data-and-actuator-ui`.

## Dữ liệu ứng dụng cục bộ

Theo yêu cầu chuẩn bị kiểm thử với phần cứng thật, đã sao lưu PostgreSQL và cấu hình MQTT trước khi dọn. Chỉ các phòng có mã `CHECK_<12 ký tự hex>` và sáu thiết bị đã ngừng sử dụng, có mã khớp từng phòng của script demo, được chọn để xóa.

- Xóa 3 phòng, 6 thiết bị, 3 số đo, 3 cảnh báo, 3 lệnh và 3 cấu hình chạy thử.
- Xóa shadow, credential, phiên kết nối, lịch sử vòng đời, sự kiện và các audit gắn với những bản ghi demo đó; xóa 6 tài khoản MQTT demo đã bị vô hiệu hóa.
- Giữ tài khoản Admin, mật khẩu, vai trò, ngưỡng mặc định, trạng thái vận hành và nhật ký tài khoản. Ghi một audit `DEMO_DATA_PURGE` cho thao tác bảo trì.
- Dọn trong transaction bằng kết nối chủ sở hữu; các trigger bảo vệ audit/lifecycle được bật lại trước commit. Kiểm tra tài khoản và cấu hình hệ thống không đổi, backend khởi động lại và sẵn sàng.

Database ứng dụng hiện không còn phòng, thiết bị, số đo, cảnh báo hoặc lệnh mẫu. Các bài kiểm thử tiếp theo chạy trên database thử nghiệm riêng. Không chạy lại `demo:backend`/`check:stack` trên database ứng dụng nếu muốn giữ trạng thái sạch.

## Giao diện

- Hai ô đèn/quạt tách biệt, có biểu tượng và bố cục thích ứng với điện thoại.
- Nhãn tiếng Việt: “Đang bật”, “Đã tắt”, “Chưa xác định”.
- Thiết bị offline chỉ thể hiện trạng thái đã nhận lần cuối; không tô trạng thái bật thành đang hoạt động.
- Cùng kiểu hiển thị trên Dashboard và trang Điều khiển; giữ khóa điều khiển theo quyền, trạng thái thiết bị và ACK thực tế.
- Dashboard trống hướng dẫn tạo phòng/kết nối thiết bị và hiển thị trạng thái chưa xác định, không bù số đo mẫu.

Đã kiểm tra TypeScript/production build, các luồng Chrome với backend thật và mock, giao diện trống/ngoại tuyến và ảnh ở kích thước máy tính/điện thoại. Chưa kiểm tra relay trên ESP32 thật.
