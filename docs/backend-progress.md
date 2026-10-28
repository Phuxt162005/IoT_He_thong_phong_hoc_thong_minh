# Tiến độ backend

Theo [kế hoạch](backend-implementation-plan.md). Chỉ ghi đã push/merge khi GitHub xác nhận; giữ kết quả kiểm thử và giới hạn thực tế.

| Mốc | Trạng thái | Bằng chứng / giới hạn |
| --- | --- | --- |
| BE-00 | Hoàn thành cục bộ, chờ push | Hợp đồng API/MQTT, ví dụ JSON, mapping legacy và ma trận kiểm thử trong `backend-contracts.md`. Đã cập nhật theo ADV-03 mới trên origin/main (`938dd24`). |
| BE-01–16 | Chưa làm | Triển khai tuần tự sau khi mốc trước được đẩy và tích hợp. |

## Ghi chú triển khai

- 28/10/2026: bắt đầu BE-00, giữ nguyên các module ADV-01/02/03 của nhóm và hai PDF chưa được theo dõi.
- Docker Desktop có cài nhưng daemon ban đầu chưa chạy; đã yêu cầu khởi động để chuẩn bị kiểm thử tích hợp thật.
