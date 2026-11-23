# Kịch bản kiểm thử prototype

Chuẩn bị hai ESP32 đã nạp firmware, backend và dashboard đang chạy, Mosquitto có thể truy cập qua LAN, một phòng thử nghiệm và hai thiết bị đã được provision. Dùng tải DC điện áp thấp và mở Serial Monitor ở `115200` baud. Xem [hướng dẫn chạy](../README.md#4-kết-nối-esp32) và [sơ đồ phần cứng](../hardware/README.md).

| Ca kiểm thử | Thao tác | Kết quả mong đợi |
| --- | --- | --- |
| Kết nối và kích hoạt | Cấp nguồn từng node. Sau khi dashboard nhận heartbeat, kích hoạt thiết bị. | Hai node hiện `ONLINE` và có heartbeat mới. Trạng thái vòng đời chuyển sang `ACTIVE`. |
| Cảm biến và OLED | Che rồi chiếu sáng BH1750, tạo chuyển động trước PIR và đối chiếu nhiệt độ/độ ẩm với một thiết bị đo tham chiếu. | Màn hình OLED và telemetry phản ánh thay đổi. Serial xác nhận DHT22 và BH1750 được nhận diện. Firmware có giá trị dự phòng khi thiếu cảm biến nên cần đối chiếu với kích thích thực tế. |
| Điều khiển đèn và quạt | Từ dashboard, lần lượt bật rồi tắt từng tải. Quan sát tải và lịch sử lệnh. | Tải tương ứng đổi trạng thái, lệnh có ACK `SUCCESS` và Device Shadow hiển thị trạng thái đã báo về. |
| Mất mạng và đồng bộ | Ngắt Wi-Fi của Sensor Node trong vài chu kỳ đo, giữ thiết bị có nguồn, rồi cho kết nối lại. | Dashboard báo `OFFLINE` sau thời gian timeout. Khi kết nối lại, các mẫu offline xuất hiện trong lịch sử theo thời điểm đo và mỗi mẫu được lưu một lần. |
| Cấu hình từ xa | Đổi chu kỳ lấy mẫu Sensor Node từ 5 giây sang 3 giây. Theo dõi ACK và bản ghi mới. | Phiên bản cấu hình đã áp dụng khớp với phiên bản gửi. Các mẫu mới xuất hiện theo chu kỳ mới. |
| Cảnh báo nhiệt độ | Đặt ngưỡng trong khoảng dự kiến của ca thử, sau đó làm số đo vượt ngưỡng. | Cảnh báo đúng phòng và thiết bị xuất hiện trên dashboard. |

Ghi phiên bản firmware, thời điểm chạy, thiết bị, kết quả thực tế và bằng chứng Serial hoặc ảnh chụp cho từng ca.
