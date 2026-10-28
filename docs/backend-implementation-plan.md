# Kế hoạch triển khai backend theo từng tính năng

Ngày lập: 28/10/2026. Mục tiêu: hoàn thiện backend hệ thống phòng học thông minh, kiểm thử và đẩy lên GitHub ngay sau khi hoàn thành từng tính năng.

## 1. Cơ sở lập kế hoạch và hiện trạng

Kế hoạch dựa trên mã nguồn hiện tại và hai tài liệu trong thư mục gốc:

- `Phát triển hệ thống phòng học thông minh.docx.pdf`: phạm vi nghiệp vụ, thiết kế MQTT, CSDL, API, phân quyền và vòng đời thiết bị.
- `ĐỀ BÀI ĐỒ ÁN KẾT THÚC HỌC PHẦN.pdf`: yêu cầu bắt buộc, kiểm thử, demo và nộp mã nguồn.

Hiện trạng đã kiểm tra:

- Có service Device Shadow: desired/reported state, gửi lệnh, nhận ACK, ghi nhận lỗi publish.
- Có service Telemetry Ingestion: kiểm tra dữ liệu, chống trùng `eventId`, tạo ACK lưu trữ.
- Repository của cả hai module đang lưu trong bộ nhớ; chưa lưu bền vững qua lần khởi động lại.
- Có adapter publish MQTT cho Device Shadow nhưng chưa có tiến trình kết nối broker và subscriber để nối các module thành hệ thống chạy thực tế.
- Có ví dụ firmware hàng đợi offline; phần đọc cảm biến trong ví dụ vẫn dùng giá trị mẫu.
- Chưa có HTTP server, xác thực, phân quyền, quản lý người dùng/phòng/thiết bị và cơ sở dữ liệu.
- `npm test`: **15/15 kiểm thử đạt** tại thời điểm lập kế hoạch. Đây là kiểm thử service, chưa chứng minh tích hợp MQTT, database hoặc phần cứng.
- Nhánh hiện tại: `main`; remote `origin`: `https://github.com/Phuxt162005/IoT_He_thong_phong_hoc_thong_minh.git`.

ADV-01 và ADV-02 đã có nền tảng để tái sử dụng; chỉ đánh dấu hoàn thành tích hợp sau khi chạy được với database, broker và thiết bị.

## 2. Định hướng kỹ thuật

- Giữ JavaScript ES modules và cấu trúc module hiện có; dùng Node.js theo yêu cầu trong `package.json`.
- Chọn Express cho HTTP API, PostgreSQL cho dữ liệu, Mosquitto cho MQTT và WebSocket cho cập nhật thời gian thực. Đây là phương án triển khai trong phạm vi công nghệ của tài liệu thiết kế.
- Tổ chức một backend theo module; mỗi module có route/controller, service và repository khi cần.
- Controller xử lý HTTP; service xử lý nghiệp vụ; repository xử lý truy cập dữ liệu. Tách MQTT adapter khỏi nghiệp vụ.
- Giữ repository in-memory cho unit test; bổ sung repository PostgreSQL và integration test.
- API bắt đầu bằng `/api/v1`; phân quyền theo vai trò **và phạm vi phòng**, kiểm tra tại backend.
- Xây nền tảng audit log sớm, ghi cùng giao dịch nghiệp vụ quan trọng; chức năng tra cứu audit triển khai sau.
- Tài liệu và mã đang khác hợp đồng dữ liệu: mã dùng `eventId`, `deviceId`, `roomCode`, timestamp ISO; thiết kế có `msg_id`, `device_id`, `room_id`, timestamp mili giây. BE-00 phải ghi rõ hợp đồng chuẩn và mapping/adapter tương thích, tránh đổi ngầm làm hỏng firmware và kiểm thử hiện có.

## 3. Danh sách tính năng theo thứ tự triển khai

Mỗi hàng là một đơn vị triển khai và đẩy GitHub riêng. Trạng thái thực tế và bằng chứng được cập nhật tại [backend-progress.md](backend-progress.md); phần hiện trạng ở trên là ảnh chụp lúc lập kế hoạch.

| Mã | Tính năng / nhánh Git | Công việc chính | Tiêu chí nghiệm thu trước khi push |
| --- | --- | --- | --- |
| BE-00 | Chốt hợp đồng tích hợp — `docs/be-00-contracts` | Lập ma trận yêu cầu; chốt API, topic, payload, đơn vị đo, timestamp, định danh, trạng thái lệnh và mapping từ mã hiện có. | Có ví dụ telemetry/ACK/command/reported/heartbeat/config; phân biệt ID nội bộ với mã thiết bị/phòng; ghi quyết định khác biệt tài liệu–mã và tiêu chí kiểm thử tương ứng. |
| BE-01 | Khởi tạo ứng dụng — `feat/be-01-bootstrap` | Tạo HTTP server, nạp và kiểm tra cấu hình, middleware lỗi, request ID, log; cập nhật README, `.env.example`, `.gitignore`; GitHub Actions chạy unit test. | Chạy được ứng dụng bằng lệnh được ghi trong README; health endpoint trả kết quả; thiếu cấu hình bắt buộc có lỗi rõ; 15 test cũ vẫn đạt; `.env`, dependency, log và secret được loại khỏi commit. |
| BE-02 | Cơ sở dữ liệu — `feat/be-02-database` | PostgreSQL, migration có phiên bản, seed, transaction helper; nền tảng bảng roles/users/rooms/devices/audit theo thiết kế; bổ sung bảng từng nghiệp vụ khi triển khai. | Database rỗng có thể migrate; seed không tạo trùng; có tài khoản thử theo vai trò; tài khoản Admin lấy mật khẩu từ môi trường; integration test chạy bằng database riêng; audit có cơ chế chỉ ghi thêm. |
| BE-03 | Đăng nhập và phiên truy cập — `feat/be-03-auth` | Login, logout, đổi mật khẩu, lấy thông tin cá nhân; băm mật khẩu, JWT, vô hiệu phiên bằng token version; giới hạn thử đăng nhập. | Từ chối mật khẩu sai, token giả/hết hạn, tài khoản bị khóa; logout/đổi mật khẩu vô hiệu phiên theo chính sách; không trả hoặc ghi log mật khẩu/token. |
| BE-04 | Người dùng và vai trò — `feat/be-04-users-rbac` | Admin tạo tài khoản, xem/cập nhật, đổi vai trò, khóa/mở tài khoản; ma trận quyền Admin/Operator/Viewer; nền tảng kiểm tra phạm vi phòng. | Viewer không sửa dữ liệu/điều khiển; Operator không quản trị tài khoản; tài khoản bị khóa hoặc đổi quyền bị áp dụng ngay; không thể tự nâng quyền; có audit. |
| BE-05 | Phòng học và phạm vi truy cập — `feat/be-05-rooms` | Tạo/sửa/danh sách/chi tiết phòng, ngừng sử dụng, gán người dùng vào phòng. | Không trùng mã phòng; giữ lịch sử khi ngừng sử dụng; người dùng không đọc/sửa phòng ngoài phạm vi qua ID, bộ lọc hoặc API con. |
| BE-06 | Quản lý vòng đời thiết bị — `feat/be-06-device-lifecycle` | Đăng ký Sensor/Control Node, gán phòng, thông tin phần cứng/firmware; mô hình REGISTERED/PROVISIONED/ACTIVE/FAULT/MAINTENANCE/REVOKED/DECOMMISSIONED; lịch sử chuyển trạng thái. | Chặn chuyển trạng thái sai và mã trùng; phân biệt lifecycle với online/offline; thao tác có lý do và audit; không xóa lịch sử thiết bị đã phát sinh dữ liệu. |
| BE-07 | Broker và xác thực thiết bị — `feat/be-07-device-credentials` | Kết nối MQTT cho backend; provision/activate/rotate/revoke credential riêng; adapter quản trị Mosquitto Dynamic Security, ACL theo loại node và thiết bị; thử nghiệm broker bằng cấu hình trong `deployment/`. | Thiết bị hợp lệ kết nối được; sai mật khẩu/sai topic bị từ chối; revoke ngắt phiên đang mở và chặn kết nối lại; chỉ chuyển ACTIVE khi provision thành công; lỗi broker không làm trạng thái DB báo thành công giả. |
| BE-08 | Nhận và lưu telemetry — `feat/be-08-telemetry` | Tích hợp service đang có với subscriber và PostgreSQL; mapping payload, thêm occupancy; đối chiếu topic–payload–thiết bị/phòng; lưu recorded/received time; migration dữ liệu lịch sử và latest. | Chỉ ACK STORED sau commit DB; mất DB không ACK thành công; retry/nhận đồng thời không tạo trùng nhờ unique constraint và insert nguyên tử; thiết bị bị thu hồi bị từ chối; bản tin offline cũ không ghi đè latest hay kích hoạt điều khiển dựa trên dữ liệu lỗi thời. |
| BE-09 | Heartbeat và online/offline — `feat/be-09-device-presence` | Nhận heartbeat/LWT, cập nhật last_seen; tác vụ quét quá hạn cấu hình được; lưu chỉ số chẩn đoán; phục hồi kết nối. | Ngắt mạng làm thiết bị chuyển OFFLINE; nối lại chuyển ONLINE đúng; không thay lifecycle bằng trạng thái kết nối; heartbeat cũ/LWT không làm lùi trạng thái mới; tác vụ khởi động lại được và không tạo sự kiện trùng. |
| BE-10 | Điều khiển, ACK và Device Shadow — `feat/be-10-commands-shadow` | API điều khiển đèn/quạt, lịch sử lệnh; tái sử dụng service shadow; PostgreSQL, MQTT ACK/reported subscriber; timeout, idempotency và kiểm soát cập nhật đồng thời. | Kiểm tra quyền/phòng/lifecycle trước gửi; gửi lệnh không tự cập nhật reported; ACK sai thiết bị bị từ chối; ACK trùng/đến muộn/sai thứ tự không ghi đè trạng thái mới; timeout vẫn xử lý sau restart; DB và MQTT lỗi có trạng thái truy vết, không mất lệnh âm thầm. |
| BE-11 | Cấu hình thiết bị từ xa — `feat/be-11-device-config` | Đọc/gửi cấu hình như chu kỳ lấy mẫu, heartbeat; validate phạm vi, lưu phiên bản mong muốn/đã áp dụng, ACK và lịch sử. | Cấu hình sai bị chặn; có ACK xác nhận áp dụng hoặc trạng thái lỗi/timeout; retry không áp dụng lặp có hại; xem được phiên bản và kết quả; có kịch bản phối hợp firmware. |
| BE-12 | Cảnh báo — `feat/be-12-alerts` | Ngưỡng nhiệt độ/độ ẩm, mất kết nối; cấu hình ngưỡng; danh sách/chi tiết/xác nhận/đóng cảnh báo; tự phục hồi và chống tạo trùng. | Vượt ngưỡng sinh cảnh báo; cùng bất thường cập nhật cảnh báo đang mở; phục hồi đóng theo chính sách; kiểm tra thứ tự ngưỡng và hysteresis; xử lý đúng quyền/phòng; có lịch sử và audit. |
| BE-13 | Tự động hóa — `feat/be-13-automation` | Quản lý rule theo phòng, điều kiện occupancy/nhiệt độ/ánh sáng; hold time, cooldown, ưu tiên và chế độ manual/auto; gọi cùng luồng command của BE-10. | Rule chỉ chạy với dữ liệu mới hợp lệ và thiết bị đủ điều kiện; không kích hoạt lần hai vì telemetry trùng/backfill; không bật/tắt liên tục; ưu tiên thao tác thủ công theo chính sách; lệnh tự động có ACK/timeout và nguồn truy vết. |
| BE-14 | Dữ liệu cho dashboard và realtime — `feat/be-14-dashboard-realtime` | API latest/history, lọc theo thiết bị/phòng/thời gian, phân trang, tổng hợp và xuất CSV; WebSocket cho telemetry, presence, command, alert. | Truy vấn đúng thời gian và đơn vị, giới hạn dữ liệu; phân quyền cả API/CSV/WebSocket; thu hồi quyền/ngắt phiên áp dụng cả kết nối đang mở; khi reconnect lấy snapshot mới; đo được độ trễ bằng kịch bản rõ ràng. |
| BE-15 | Tra cứu nhật ký — `feat/be-15-audit` | API audit log và lifecycle history có bộ lọc/phân trang; rà soát các tính năng trước đã ghi đủ thao tác quan trọng. | Truy ra người/thiết bị/hệ thống, đối tượng, thời gian và kết quả; chỉ vai trò phù hợp được xem; không có API sửa/xóa; không chứa secret; lỗi ghi audit không để nghiệp vụ quan trọng commit thiếu nhật ký. |
| BE-16 | Đóng gói và kiểm thử đầu cuối — `feat/be-16-deployment-e2e` | Hoàn thiện Docker Compose backend/PostgreSQL/Mosquitto, migration, readiness, graceful shutdown, retention/backup; mở rộng CI integration; OpenAPI và hướng dẫn demo/khôi phục. | Clone mới chạy được theo README; kiểm thử luồng đầu cuối với ESP32 và frontend; restart không mất dữ liệu; kiểm tra khôi phục backup; báo cáo đo lường và kiểm thử bảo mật; tạo phiên bản cuối khi đủ tiêu chí bên dưới. |

BE-00/01/02 là nền tảng. Từ BE-03 trở đi, mỗi tính năng phải có hành vi kiểm chứng được qua API hoặc MQTT; không coi chỉ có service hay giao diện khai báo là hoàn thành.

## 4. Quy trình GitHub sau từng tính năng

Quy ước: một nhánh cho mỗi mã BE; hoàn thành, kiểm thử, commit rồi push nhánh đó ngay. Một tính năng có thể có vài commit nhỏ nếu cần; lịch sử phải thể hiện rõ kết quả từng mốc.

1. Bắt đầu từ `main` đã đồng bộ, tạo nhánh theo bảng. Hoàn tất tích hợp tính năng trước vào `main` trước khi bắt đầu tính năng phụ thuộc.
2. Triển khai đúng phạm vi tính năng; thêm migration, tài liệu API và kiểm thử hành vi liên quan.
3. Chạy `npm test` và integration test có liên quan; từ khi có database/broker phải kiểm thử bằng dịch vụ thật cho phần tích hợp tương ứng.
4. Cập nhật trạng thái mã BE trong tài liệu này: việc đã làm, cách chạy, kết quả kiểm thử và giới hạn còn lại.
5. Xem `git diff`, `git status`; stage rõ các tệp của tính năng. Hai PDF hiện chưa được Git theo dõi: không tự đưa vào commit tính năng nếu chưa có chủ đích quản lý chúng trong repo.
6. Commit có mã BE và hành vi cụ thể, ví dụ `feat(auth): BE-03 đăng nhập, đăng xuất và đổi mật khẩu`.
7. Push nhánh lên `origin`, mở Pull Request vào `main`, mô tả kết quả và bằng chứng kiểm thử. Kiểm tra CI; sửa và push tiếp nếu CI lỗi.
8. Chỉ đánh dấu **đã tích hợp** khi PR đã merge và kiểm tra nhánh chính đạt. Push nhánh thành công và merge vào `main` là hai trạng thái riêng.

Ví dụ tạo nhánh BE-03 khi BE-02 đã tích hợp:

```powershell
git switch main
git pull --ff-only origin main
git switch -c feat/be-03-auth
```

Sau khi đã triển khai và kiểm thử, stage các tệp thực tế của BE-03, sau đó:

```powershell
git diff --cached
git commit -m "feat(auth): BE-03 đăng nhập, đăng xuất và đổi mật khẩu"
git push -u origin feat/be-03-auth
```

Không đánh dấu đã push nếu lệnh push thất bại. Nếu thiếu quyền GitHub hoặc mạng, ghi rõ phần đã commit cục bộ và nhánh cần push để tiếp tục từ đúng mốc. Không dùng force push cho quy trình thông thường.

## 5. Điều kiện hoàn thành chung cho một tính năng

- [ ] Hành vi chính chạy được bằng API/MQTT; có ví dụ request/payload và kết quả.
- [ ] Có kiểm tra đầu vào, lỗi nghiệp vụ và quyền/phạm vi truy cập phù hợp.
- [ ] Migration và dữ liệu bền vững hoạt động nếu tính năng có lưu trữ.
- [ ] Test tính năng và test cũ đạt; có tình huống thất bại quan trọng, không chỉ đường đi thành công.
- [ ] Có audit cho thao tác quan trọng; không chứa mật khẩu, token hoặc credential thật trong code/log/commit.
- [ ] README, `.env.example`, API/MQTT contract và tiến độ được cập nhật khi thay đổi.
- [ ] Commit đúng phạm vi, push thành công; ghi liên kết PR và kết quả CI.

Theo dõi mỗi mã BE bằng mẫu:

```text
Mã: BE-xx
Trạng thái: Chưa làm / Đang làm / Đã push / Đã tích hợp
Nhánh:
Commit / Pull Request:
Kết quả kiểm thử:
Giới hạn và việc tiếp theo:
```

## 6. Lịch dự kiến

Lịch dưới đây là phương án phân bổ, giả định có thể làm backend thường xuyên và phối hợp firmware/frontend. Mỗi mã BE vẫn push riêng dù cùng ngày hoàn thành nhiều mã.

| Khoảng ngày năm 2026 | Mục tiêu |
| --- | --- |
| 28–30/10 | BE-00 → BE-02: hợp đồng, ứng dụng chạy được, database và CI ban đầu. |
| 31/10–03/11 | BE-03 → BE-06: người dùng, phân quyền, phòng học và vòng đời thiết bị. |
| 04–08/11 | BE-07 → BE-09: broker, credential, telemetry lưu thật và online/offline. |
| 09–12/11 | BE-10 → BE-11: điều khiển, ACK, shadow và cấu hình từ xa. |
| 13–16/11 | BE-12 → BE-13: cảnh báo và tự động hóa. |
| 17–20/11 | BE-14 → BE-16: dashboard API/realtime, audit và đóng gói đầu cuối. |
| 21–23/11 | Dự phòng sửa lỗi tích hợp, đo lường, chạy demo và hoàn thiện hướng dẫn. |
| 24/11 | Mốc nộp báo cáo/source code theo đề bài hiện có; tạo release cuối khi đạt kiểm thử. |

Hạn 24/11 được lấy từ PDF đề bài trong repo, chưa xác minh có thông báo điều chỉnh. Các chức năng nâng cao mới như OTA/AI chỉ đưa vào sau khi các yêu cầu bắt buộc đã hoạt động ổn định; tiếp tục tận dụng phần ADV-01/02 đang có.

## 7. Tiêu chí nghiệm thu backend cuối cùng

1. Đăng nhập bằng ba vai trò; người dùng không truy cập hoặc điều khiển ngoài phạm vi phòng.
2. Đăng ký, provision, gán phòng và kích hoạt thiết bị có credential riêng.
3. ESP32 thật gửi telemetry qua MQTT, PostgreSQL lưu đúng, frontend nhận dữ liệu mới và truy vấn lịch sử được.
4. Gửi lệnh đèn/quạt, nhận ACK, hiển thị reported state; mất ACK được xử lý timeout.
5. Thay cấu hình từ xa và chứng minh thiết bị đã áp dụng bằng ACK/kết quả thực tế.
6. Ngắt mạng, phát hiện offline, kết nối lại và đồng bộ dữ liệu không trùng.
7. Gây vượt ngưỡng, sinh/xác nhận/đóng cảnh báo; demo rule tự động qua cùng luồng command.
8. Thu hồi hoặc decommission thiết bị: phiên đang kết nối bị vô hiệu, thiết bị không tiếp tục gửi dữ liệu hoặc kết nối lại được.
9. Có bằng chứng kiểm thử bảo mật: token không hợp lệ, truy cập chéo phòng, credential bị thu hồi và MQTT sai topic; lưu kết quả trong `tests/` hoặc `docs/`.
10. Clone mới có thể chạy theo README; có log, kiểm thử restart/backup, kết quả đo độ trễ và giới hạn hệ thống.
11. Các tính năng đã được push và tích hợp; CI đạt; tạo tag/release `v1.0.0` sau khi nghiệm thu toàn hệ thống.

Bước triển khai đầu tiên: **BE-00**, sau đó **BE-01**. Hợp đồng tích hợp nằm tại [backend-contracts.md](backend-contracts.md); xem tiến độ để biết mốc đã được kiểm thử, push và tích hợp.
