# Tiến độ backend

Theo [kế hoạch](backend-implementation-plan.md). Chỉ ghi đã push/merge khi GitHub xác nhận; giữ kết quả kiểm thử và giới hạn thực tế.

| Mốc | Trạng thái | Bằng chứng / giới hạn |
| --- | --- | --- |
| BE-00 | Đã push và tích hợp | [PR #1](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/1), commit `4332a37`, merge `bd4126a`; 24/24 test và 12 ví dụ JSON đạt. |
| BE-01 | Đã push và tích hợp | [PR #2](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/2), commit `5233fa1`, merge `0c860be`; 28/28 test cục bộ và CI Node 22/24 đạt. |
| BE-02 | Đã push và tích hợp | [PR #3](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/3), commit `1ccc82a`, merge `e726319`; 29 unit và 4 integration test PostgreSQL thật đạt cả cục bộ/CI. |
| BE-03 | Đã push và tích hợp | [PR #4](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/4), commit `55d0a81`, merge `ef6a631`; 29 unit và 9 integration test đạt cục bộ/CI; smoke entrypoint thật với database ứng dụng cũng đạt. |
| BE-04 | Đã kiểm thử cục bộ, chờ push/CI | 29 unit và 14 integration test đạt: Admin quản lý tài khoản; Operator/Viewer bị từ chối; đổi quyền/khóa vô hiệu JWT; giữ Admin cuối khi đồng thời; API rate limit nguyên tử. Có helper phạm vi phòng dùng ở BE-05. |
| BE-05–16 | Chưa làm | Triển khai tuần tự sau khi mốc trước được đẩy và tích hợp. |

## Ghi chú triển khai

- 28/10/2026: bắt đầu BE-00, giữ nguyên các module ADV-01/02/03 của nhóm và hai PDF chưa được theo dõi.
- Docker Desktop đã chạy; hai container PostgreSQL 17 cho ứng dụng và test đã healthy, chỉ mở cổng loopback. `.env`/`.env.test` chứa secret ngẫu nhiên cục bộ và được loại khỏi Git.
