# Tiến độ backend

Theo [kế hoạch](backend-implementation-plan.md). Chỉ ghi đã push/merge khi GitHub xác nhận; giữ kết quả kiểm thử và giới hạn thực tế.

| Mốc | Trạng thái | Bằng chứng / giới hạn |
| --- | --- | --- |
| BE-00 | Đã push và tích hợp | [PR #1](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/1), commit `4332a37`, merge `bd4126a`; 24/24 test và 12 ví dụ JSON đạt. |
| BE-01 | Đã push và tích hợp | [PR #2](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/2), commit `5233fa1`, merge `0c860be`; 28/28 test cục bộ và CI Node 22/24 đạt. |
| BE-02 | Đã push và tích hợp | [PR #3](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/3), commit `1ccc82a`, merge `e726319`; 29 unit và 4 integration test PostgreSQL thật đạt cả cục bộ/CI. |
| BE-03 | Đã push và tích hợp | [PR #4](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/4), commit `55d0a81`, merge `ef6a631`; 29 unit và 9 integration test đạt cục bộ/CI; smoke entrypoint thật với database ứng dụng cũng đạt. |
| BE-04 | Đã push và tích hợp | [PR #5](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/5), head `727683a`, merge `16dae03`; sau tích hợp ADV-04 có 38 unit và 14 integration test đạt cục bộ/CI. |
| BE-05 | Đã push và tích hợp | [PR #6](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/6), commit `0dfcfac`, merge `af5ea7d`; 38 unit và 18 integration test đạt cục bộ/CI. |
| BE-06 | Đã push và tích hợp | [PR #7](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/7), commit `0c402ce`, merge `6a09eb3`; 38 unit và 23 integration test đạt cục bộ/CI. Provision/activate/revoke được nối với broker thật ở BE-07. |
| BE-07 | Đã push và tích hợp | [PR #8](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/8), commit `188331b`, merge `0547e5b`; 39 unit và 28 integration test PostgreSQL/Mosquitto thật đạt cục bộ/CI. |
| BE-08 | Đã push và tích hợp | [PR #9](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/9), commit `f1b88cf`, merge `07478f1`; 39 unit và 35 integration test đạt cục bộ/CI. |
| BE-09 | Đã push và tích hợp | [PR #10](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/10), commit `5314abc`, merge `62606bd`; 39 unit và 40 integration test đạt cục bộ/CI. |
| BE-10 | Đã push và tích hợp | [PR #11](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/11), commit `6d52134`, merge `986c1c7`; 39 unit và 49 integration test đạt cục bộ/CI. |
| BE-11 | Đã push và tích hợp | [PR #12](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/12), commit `4b61795`, merge `c1601ad`; 39 unit và 54 integration test đạt cục bộ/CI. Chưa xác nhận áp dụng config trên ESP32 thật. |
| BE-12 | Đã push và tích hợp | [PR #13](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/13), commit `17deb28`, merge `0146680`; 39 unit và 60 integration test đạt cục bộ/CI. |
| BE-13 | Đã push và tích hợp | [PR #14](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/14), commit `ab4c437`, merge `5cf484d`; 39 unit và 66 integration test đạt cục bộ/CI. |
| BE-14 | Đã push và tích hợp | [PR #15](https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh/pull/15), commit `d631fe9`, merge `67e411b`; 39 unit và 72 integration test đạt cục bộ/CI; entrypoint smoke đạt. Loopback MQTT→WS khoảng 62–65 ms. |
| BE-15 | Đã kiểm thử cục bộ, chờ push/CI | 39 unit và 76 integration test đạt; API audit chỉ Admin, bộ lọc actor/target/action/result/request/thời gian; lifecycle theo scope; che secret lồng nhau trước khi lưu. |
| BE-16 | Chưa làm | Đóng gói, kiểm thử đầu cuối và hướng dẫn vận hành. |

## Ghi chú triển khai

- 28/10/2026: bắt đầu BE-00, giữ nguyên các module ADV-01/02/03 của nhóm và hai PDF chưa được theo dõi.
- Docker Desktop đã chạy; hai container PostgreSQL 17 cho ứng dụng và test đã healthy, chỉ mở cổng loopback. `.env`/`.env.test` chứa secret ngẫu nhiên cục bộ và được loại khỏi Git.
- Trong BE-04, origin/main có ADV-04 mới (`9ee8666`) làm mất script start/dev/database/integration trong package.json. Đã merge phần AI của nhóm và khôi phục đầy đủ script backend, giữ test:anomaly-detection; kiểm tra lại trước khi tích hợp BE-04.
