# Tiến độ backend

Theo [kế hoạch](backend-implementation-plan.md). Chỉ ghi đã push/merge khi GitHub xác nhận; giữ kết quả kiểm thử và giới hạn thực tế.

| Mốc | Trạng thái | Bằng chứng / giới hạn |
| --- | --- | --- |
| BE-00 | Đã push và tích hợp | [PR #1](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/1), commit `4332a37`, merge `bd4126a`; 24/24 test và 12 ví dụ JSON đạt. |
| BE-01 | Đã kiểm thử cục bộ, chờ push/CI | 28/28 test đạt, gồm 4 test HTTP thực kiểm tra health/readiness, request ID, lỗi/JSON/body limit và CORS; Express app/server, cấu hình, logger ADV-03, graceful shutdown, npm scripts và CI Node 22/24. Chưa nối database/broker theo phạm vi BE-01. |
| BE-02–16 | Chưa làm | Triển khai tuần tự sau khi mốc trước được đẩy và tích hợp. |

## Ghi chú triển khai

- 28/10/2026: bắt đầu BE-00, giữ nguyên các module ADV-01/02/03 của nhóm và hai PDF chưa được theo dõi.
- Docker Desktop có cài nhưng daemon ban đầu chưa chạy; đã yêu cầu khởi động để chuẩn bị kiểm thử tích hợp thật.
