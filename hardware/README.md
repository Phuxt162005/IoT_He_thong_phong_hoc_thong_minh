# Phần cứng phòng học thông minh

Mô hình dùng hai ESP32 DevKit. Sensor Node đo môi trường và hiển thị số đo trên OLED. Control Node điều khiển hai tải DC qua relay.

## Danh sách linh kiện

| Linh kiện | Số lượng | Công dụng |
| --- | ---: | --- |
| ESP32 DevKit | 2 | Một bo cho Sensor Node, một bo cho Control Node. |
| DHT22 | 1 | Đo nhiệt độ và độ ẩm. DHT22 dạng rời cần điện trở kéo lên 10 kΩ cho DATA. |
| BH1750 | 1 | Đo độ rọi qua I²C. |
| PIR HC-SR501 | 1 | Phát hiện chuyển động. |
| OLED SSD1306 I²C 128 × 64 | 1 | Hiển thị số đo, trạng thái Wi-Fi/MQTT và hàng đợi. |
| Module relay hai kênh | 1 | Đóng ngắt đèn và quạt. Chọn module nhận được tín hiệu điều khiển 3,3 V từ ESP32. |
| Đèn LED DC và quạt DC | 1 mỗi loại | Tải thử nghiệm. Dùng nguồn phù hợp với điện áp và dòng định mức của tải. |
| Cáp USB, dây nối, breadboard và nguồn DC | Theo mô hình | Cấp nguồn và lắp thử mạch. |

## Nối dây theo firmware

### Sensor Node

| Linh kiện | Chân tín hiệu | Nguồn và kết nối phụ |
| --- | --- | --- |
| DHT22 | DATA → GPIO 4 | VCC → 3V3, GND → GND. Với cảm biến rời, mắc điện trở 10 kΩ giữa DATA và 3V3. |
| BH1750 | SDA → GPIO 21, SCL → GPIO 22 | VCC → 3V3, GND → GND. Firmware thử địa chỉ `0x23`, sau đó `0x5C`. |
| OLED SSD1306 | SDA → GPIO 21, SCL → GPIO 22 | Dùng chung bus I²C với BH1750. Firmware dùng địa chỉ `0x3C`. Cấp nguồn phù hợp với module, giữ mức tín hiệu I²C ở 3,3 V. |
| PIR HC-SR501 | OUT → GPIO 27 | VCC → 5 V, GND → GND. Kiểm tra mức OUT phù hợp với GPIO ESP32. |

Xem [cấu hình Sensor Node](../firmware/sensor_node/Config.h.example).

### Control Node

| Chân ESP32 | Kết nối |
| --- | --- |
| GPIO 25 | Chân IN của kênh relay đóng ngắt quạt (FAN). |
| GPIO 26 | Chân IN của kênh relay đóng ngắt đèn (LIGHT). |
| GND | GND phía tín hiệu của module theo sơ đồ nhà sản xuất. |

`RELAY_ACTIVE_LOW=true` trong [cấu hình Control Node](../firmware/control_node/Config.h.example) tương ứng với module kích mức thấp. Cấp nguồn relay theo module đang dùng. Với mỗi tải DC trong mô hình, nối dương nguồn vào COM, nối NO vào dương tải và nối âm tải về âm nguồn. Dùng tải DC điện áp thấp khi kiểm thử.

### Sơ đồ từ báo cáo thiết kế

![Sơ đồ nối dây Sensor Node và Control Node trong báo cáo thiết kế](images/wiring-design.png)

Hình 6.8 trích từ báo cáo thiết kế. Bảng chân phía trên bổ sung OLED và xác định kênh theo tải đèn/quạt trong cấu hình firmware.

## Ảnh prototype

Hồ sơ hiện có sơ đồ thiết kế. Mục này đang chờ ảnh chụp hai ESP32 đã lắp mạch, gồm Sensor Node với cảm biến/OLED, Control Node với relay/tải và một ảnh toàn cảnh prototype.
