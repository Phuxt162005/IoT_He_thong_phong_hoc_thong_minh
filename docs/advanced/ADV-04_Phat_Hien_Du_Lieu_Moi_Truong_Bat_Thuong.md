# ADV-04 — Phát hiện dữ liệu môi trường bất thường

## 1. Tổng quan

**Mã chức năng:** ADV-04  
**Tên chức năng:** Phát hiện dữ liệu môi trường bất thường  
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)  
**Trạng thái:** Đã triển khai thuật toán, PostgreSQL repository, consumer xử lý sự kiện nền và tích hợp vào Backend. Kết quả kiểm thử local do nhóm cung cấp: **16/16 test ADV-04 PASS** và **52/52 test toàn dự án PASS**. Migration `016_anomaly_detection.sql` đã được áp dụng thành công tại môi trường local.

### 1.1. Mục tiêu

ADV-04 phân tích dữ liệu cảm biến môi trường để phát hiện các giá trị lệch đáng kể so với hành vi thông thường của từng thiết bị. Kết quả phân tích có thông tin giải thích, có thể được Backend sử dụng cho các chức năng giám sát, cảnh báo và hiển thị ở các bước phát triển tiếp theo.

### 1.2. Phạm vi

Module hiện hỗ trợ ba trường dữ liệu:

- `temperatureC`: nhiệt độ.
- `humidityPercent`: độ ẩm.
- `illuminanceLux`: độ rọi.

Các chức năng chính:

- Tạo và quản lý baseline riêng theo từng thiết bị và từng chỉ số.
- Trả trạng thái `WARMING_UP` khi chưa đủ số mẫu lịch sử.
- Sử dụng Median, MAD và Robust Z-score để đánh giá độ lệch của mẫu mới.
- Phân loại mẫu thành `NORMAL` hoặc `ANOMALY` khi baseline đã đủ dữ liệu.
- Không thêm mẫu đã bị phát hiện bất thường vào baseline.
- Giới hạn số mẫu baseline bằng cửa sổ trượt.
- Nhận diện sự kiện đã xử lý để tránh phân tích lặp.
- Lưu baseline và kết quả phân tích trong PostgreSQL.
- Tiếp nhận sự kiện `telemetry.stored` thông qua consumer chạy nền.
- Bỏ qua dữ liệu không đủ điều kiện, dữ liệu backfill, dữ liệu lệch đồng hồ, dữ liệu không còn mới nhất hoặc thiết bị/phòng học không hoạt động.
- Hỗ trợ reset baseline của một chỉ số thông qua service.

**Lưu ý về thuật ngữ:** phiên bản này sử dụng phương pháp thống kê robust để phát hiện bất thường, chưa phải mô hình machine learning được huấn luyện. Vì vậy, không sử dụng kết quả unit test để kết luận độ chính xác của mô hình trên dữ liệu thực tế.

## 2. Thiết kế và nguyên lý hoạt động

### 2.1. Đường cơ sở (baseline)

Baseline lưu các mẫu lịch sử gần nhất cho từng cặp `deviceId`–`metric`. Cấu hình mặc định:

| Tham số | Giá trị mặc định | Ý nghĩa |
|---|---:|---|
| `minSamples` | 8 | Số mẫu lịch sử tối thiểu trước khi phát hiện bất thường |
| `windowSize` | 30 | Số mẫu tối đa được giữ trong baseline |
| `threshold` | 3.5 | Ngưỡng trị tuyệt đối của Robust Z-score |

Các tham số được cấu hình trong constructor của `AnomalyDetectionService`, có thể thay đổi khi kiểm thử hoặc tích hợp.

Baseline được lưu trong bảng `anomaly_baselines`, phân biệt theo `device_id` và `metric`. Mỗi baseline giữ tối đa 30 mẫu gần nhất. Việc lưu trong PostgreSQL giúp baseline được duy trì sau khi Backend khởi động lại.

### 2.2. Median, MAD và Robust Z-score

Khi baseline đã đủ mẫu, service tính Median của lịch sử và MAD (Median Absolute Deviation), tức Median của độ lệch tuyệt đối giữa từng mẫu và Median.

Với MAD khác 0, điểm số được tính như sau:

\[
\text{Robust Z-score} = \frac{0.6745(x-\text{Median})}{\text{MAD}}
\]

Nếu trị tuyệt đối của điểm số lớn hơn hoặc bằng `threshold`, mẫu được đánh dấu `ANOMALY`; nếu không, mẫu được đánh dấu `NORMAL`.

Nếu MAD bằng 0:

- Nếu giá trị mới bằng Median, điểm số là 0 và mẫu được coi là bình thường.
- Nếu giá trị mới khác Median, mẫu được đánh dấu bất thường với lý do `DEVIATION_FROM_CONSTANT_BASELINE`; trường `score` trả về `null`.

Cách xử lý MAD bằng 0 giúp tránh phép chia cho 0. Tuy nhiên, phương pháp này có thể nhạy với baseline không biến thiên và cần được đánh giá thêm trên dữ liệu cảm biến thực tế.

### 2.3. Luồng xử lý

Luồng xử lý ADV-04 gồm hai phần: tiếp nhận sự kiện ở consumer và phân tích dữ liệu ở service.

**Phần 1 — Consumer tiếp nhận telemetry**

1. Consumer truy vấn các sự kiện `telemetry.stored` chưa được đánh dấu delivery cho consumer `anomaly_detection`.
2. Mỗi sự kiện được xử lý trong transaction riêng.
3. Consumer đọc sự kiện và bản ghi tương ứng trong `sensor_data`.
4. Kiểm tra điều kiện dữ liệu: `eligible`, `is_latest`, `is_backfill`, `clock_skew`; đồng thời kiểm tra cờ backfill và clock skew trong bản ghi telemetry.
5. Kiểm tra thiết bị có trạng thái `ACTIVE`, phòng học có trạng thái `ACTIVE`.
6. Đối chiếu `data_id` với bản ghi mới nhất của thiết bị trong `telemetry_latest`.
7. Nếu dữ liệu không đủ điều kiện, consumer bỏ qua và ghi nhận delivery.
8. Nếu dữ liệu hợp lệ, consumer gọi `AnomalyDetectionService` để phân tích.
9. Chỉ sau khi baseline và kết quả được lưu thành công, consumer mới ghi nhận delivery. Nếu xử lý phát sinh lỗi, transaction rollback để sự kiện có thể được thử lại ở lần chạy sau.

**Phần 2 — Service phân tích bất thường**

1. Xác thực payload, `deviceId`, `eventId` nếu có, timestamp nếu có và các trường cảm biến được hỗ trợ.
2. Kiểm tra sự kiện đã có kết quả xử lý chưa.
3. Với từng chỉ số có trong telemetry, đọc baseline tương ứng từ repository.
4. Nếu chưa đủ `minSamples`, thêm mẫu vào baseline và trả `WARMING_UP`.
5. Nếu đã đủ mẫu, tính Median, MAD và Robust Z-score.
6. Trả kết quả `NORMAL` hoặc `ANOMALY` kèm thông tin giải thích.
7. Chỉ thêm mẫu bình thường vào baseline; không thêm mẫu bất thường.
8. Lưu kết quả phân tích vào PostgreSQL.

Trong luồng Consumer hiện tại, `eventId` được gán từ `data_id` của bản ghi telemetry để sử dụng ổn định cho việc nhận diện sự kiện đã xử lý.

### 2.4. Kết quả phân tích

Kết quả tổng thể của service có các trường chính:

| Trường | Ý nghĩa |
|---|---|
| `eventId` | Mã sự kiện đầu vào |
| `deviceId` | Mã thiết bị |
| `timestamp` | Thời điểm của telemetry nếu được cung cấp |
| `analyzedAt` | Thời điểm phân tích |
| `anomalyDetected` | `true` nếu có ít nhất một chỉ số bất thường |
| `findings` | Danh sách kết quả cho từng chỉ số |
| `duplicate` | Cho biết kết quả được trả lại từ sự kiện đã xử lý trước đó |

Mỗi phần tử trong `findings` có thể gồm `metric`, `value`, `status`, `anomaly`, `baselineSamples`, `median`, `mad`, `score`, `threshold` và `reason`, tùy trạng thái xử lý.

Các trạng thái:

- `WARMING_UP`: chưa đủ dữ liệu để kết luận.
- `NORMAL`: giá trị nằm trong ngưỡng baseline.
- `ANOMALY`: giá trị lệch khỏi baseline theo quy tắc đã cấu hình.

### 2.5. Lưu trữ dữ liệu

ADV-04 sử dụng hai bảng mới trong PostgreSQL:

| Bảng | Vai trò |
|---|---|
| `anomaly_baselines` | Lưu danh sách mẫu baseline theo từng thiết bị và chỉ số cảm biến |
| `anomaly_detection_results` | Lưu kết quả phân tích theo từng bản ghi telemetry, bao gồm trạng thái bất thường và danh sách `findings` dạng JSONB |

Bảng `anomaly_detection_results` liên kết với `sensor_data` thông qua `data_id`. Mỗi bản ghi telemetry chỉ có tối đa một kết quả phân tích. Các index hỗ trợ truy vấn kết quả theo thời gian, phòng học và thiết bị.

Migration tạo hai bảng là `database/migrations/016_anomaly_detection.sql`. Theo kết quả chạy local do nhóm cung cấp, migration đã được áp dụng với `applied: 1`.

## 3. Cấu trúc source code

```text
source code IoT/
├── package.json
├── database/
│   └── migrations/
│       └── 016_anomaly_detection.sql
├── tests/
│   ├── anomaly-detection.test.js
│   └── anomaly-detection-consumer.test.js
└── backend/
    └── src/
        ├── server.js
        └── modules/
            └── anomaly-detection/
                ├── anomaly-detection.errors.js
                ├── anomaly-detection.repository.memory.js
                ├── anomaly-detection.repository.pg.js
                ├── anomaly-detection.service.js
                └── anomaly-detection.consumer.js
```

## 4. Trách nhiệm của từng file

| File | Trách nhiệm |
|---|---|
| `anomaly-detection.errors.js` | Định nghĩa `AnomalyDetectionError` và mã lỗi |
| `anomaly-detection.repository.memory.js` | Repository trong bộ nhớ phục vụ unit test service |
| `anomaly-detection.repository.pg.js` | Đọc, cập nhật baseline; kiểm tra sự kiện đã xử lý; lưu kết quả và reset baseline trong PostgreSQL |
| `anomaly-detection.service.js` | Xác thực telemetry, tính thống kê robust, phân loại kết quả và quản lý baseline |
| `anomaly-detection.consumer.js` | Đọc sự kiện telemetry chưa xử lý, kiểm tra điều kiện, gọi service và ghi nhận delivery trong transaction |
| `server.js` | Khởi tạo consumer và chạy job `anomaly-detection` định kỳ |
| `016_anomaly_detection.sql` | Tạo bảng baseline, bảng kết quả và các index phục vụ truy vấn |
| `anomaly-detection.test.js` | Unit test cho thuật toán, baseline, dữ liệu đầu vào, chống trùng và reset |
| `anomaly-detection-consumer.test.js` | Kiểm thử logic consumer bằng mock, gồm xử lý hợp lệ, bỏ qua dữ liệu và rollback |
| `package.json` | Khai báo lệnh chạy test ADV-04 và toàn bộ test |

## 5. Kiểm tra đầu vào và chống xử lý trùng

### 5.1. Kiểm tra đầu vào

Service kiểm tra:

- Payload phải là object hợp lệ, không phải `null` hoặc mảng.
- `deviceId` phải là chuỗi không rỗng.
- `eventId`, nếu được cung cấp, phải là chuỗi không rỗng.
- Timestamp, nếu được cung cấp, phải phân tích được thành thời gian hợp lệ.
- Các chỉ số được hỗ trợ phải là số hữu hạn.
- Độ ẩm phải nằm trong khoảng 0–100%.
- Độ rọi không được âm.
- Payload phải có ít nhất một chỉ số cảm biến được hỗ trợ.

Nhiệt độ được kiểm tra là số hữu hạn; giới hạn nhiệt độ vật lý cụ thể chưa được thiết lập trong service.

Ở luồng Consumer, `eventId` được tạo từ `data_id` nên có giá trị ổn định. Tuy nhiên, khi gọi service độc lập, `eventId` hiện vẫn là trường tùy chọn; nếu không cung cấp, cơ chế chống xử lý trùng của service không được bảo đảm cho lần gọi đó.

### 5.2. Chống xử lý trùng và retry

- Service kiểm tra kết quả đã xử lý theo `data_id` và đối chiếu `deviceId`.
- Consumer sử dụng bảng `iot_event_deliveries` với consumer name `anomaly_detection` để theo dõi sự kiện đã xử lý.
- Việc lưu baseline, kết quả phân tích và delivery được thực hiện trong transaction của Consumer.
- Nếu xử lý thất bại trước khi transaction commit, các thay đổi trong transaction được rollback; sự kiện chưa được đánh dấu delivery và có thể được thử lại.
- Các sự kiện không đủ điều kiện được bỏ qua và đánh dấu delivery để tránh lặp lại việc kiểm tra ở những lượt chạy sau.

## 6. Kiểm thử

### 6.1. Lệnh chạy

Chạy riêng các test ADV-04:

```powershell
npm run test:anomaly-detection
```

Chạy toàn bộ test của repository:

```powershell
npm test
```

Áp dụng migration:

```powershell
npm run db:migrate
```

### 6.2. Các trường hợp kiểm thử ADV-04

| STT | Trường hợp | Kết quả |
|---:|---|---|
| 1 | Trả `WARMING_UP` khi chưa đủ mẫu | PASS |
| 2 | Phát hiện nhiệt độ lệch khỏi baseline | PASS |
| 3 | Giá trị bình thường không bị đánh dấu bất thường | PASS |
| 4 | Không đưa điểm bất thường vào baseline | PASS |
| 5 | Xử lý nhiều chỉ số trong cùng telemetry | PASS |
| 6 | Từ chối dữ liệu cảm biến không hợp lệ | PASS |
| 7 | Không cập nhật baseline lần hai khi nhận trùng `eventId` | PASS |
| 8 | Reset baseline của một chỉ số | PASS |
| 9 | Từ chối reset với chỉ số không hỗ trợ | PASS |
| 10 | Consumer xử lý telemetry hợp lệ và lưu baseline, kết quả, delivery | PASS |
| 11 | Consumer bỏ qua telemetry không eligible | PASS |
| 12 | Consumer bỏ qua dữ liệu backfill hoặc clock skew | PASS |
| 13 | Consumer bỏ qua thiết bị hoặc phòng học không hoạt động | PASS |
| 14 | Rollback và không đánh dấu delivery khi lưu kết quả thất bại | PASS |
| 15 | Không xử lý lại sự kiện đã được đánh dấu delivery | PASS |
| 16 | Bỏ qua telemetry không còn là bản ghi mới nhất | PASS |

### 6.3. Kết quả kiểm thử local

Theo ảnh kết quả do nhóm cung cấp:

**Kiểm thử riêng ADV-04:**

- Tổng số test: 16.
- Thành công: 16.
- Thất bại: 0.
- Bị hủy: 0.
- Bị bỏ qua: 0.

**Kiểm thử toàn bộ repository:**

- Tổng số test: 52.
- Thành công: 52.
- Thất bại: 0.
- Bị hủy: 0.
- Bị bỏ qua: 0.
- Thời gian thực thi hiển thị trên terminal: khoảng 1078.94 ms.

**Migration:** lệnh `npm run db:migrate` trả về `{"command":"migrate","applied":1}` trong lần áp dụng migration 016.

Các kết quả trên xác nhận unit test và consumer mock test tại local đã đạt. Consumer test sử dụng mock PostgreSQL client, do đó không được xem là kiểm thử tích hợp PostgreSQL thực tế.

## 7. Hạn chế hiện tại

1. **Chưa có kiểm thử PostgreSQL integration riêng cho ADV-04:** migration đã được áp dụng tại local, nhưng chưa có kết quả kiểm thử tự động xác nhận toàn bộ thao tác đọc/ghi baseline và kết quả trên PostgreSQL thật.
2. **Chưa kiểm thử đầu cuối với ESP32 và MQTT:** chưa có bằng chứng kiểm thử toàn bộ đường đi từ thiết bị, broker, telemetry ingestion đến Consumer phát hiện bất thường.
3. **Chưa kết nối kết quả với giao diện/dashboard:** kết quả đã được lưu trong database, nhưng chưa có bằng chứng về chức năng truy vấn và hiển thị kết quả ADV-04 trên giao diện.
4. **Chưa kết nối trực tiếp với chức năng cảnh báo:** Consumer hiện lưu kết quả phân tích; việc chuyển kết quả `ANOMALY` thành cảnh báo cho người dùng chưa được xác nhận là đã tích hợp.
5. **Chưa có dữ liệu đánh giá thực nghiệm:** chưa đo precision, recall, false-positive rate hoặc độ trễ phát hiện trên tập dữ liệu cảm biến thực tế.
6. **Giai đoạn warming-up có thể hấp thụ điểm đột biến:** các mẫu ban đầu được đưa vào baseline trước khi có đủ lịch sử để phân loại.
7. **MAD bằng 0 có thể nhạy:** mọi giá trị khác Median bị đánh dấu bất thường.
8. **Chưa có giới hạn nhiệt độ theo ngữ cảnh:** service chỉ xác thực nhiệt độ là số hữu hạn, chưa xác định dải hợp lệ theo loại cảm biến.
9. **`eventId` vẫn tùy chọn khi gọi service độc lập:** Consumer đã cung cấp `data_id` làm mã sự kiện, nhưng các nơi gọi service khác cần bảo đảm truyền mã ổn định.
10. **Chưa phải mô hình ML được huấn luyện:** thuật toán hiện tại là phương pháp thống kê robust. Cần dữ liệu, quy trình huấn luyện và đánh giá riêng nếu muốn phát triển thành mô hình học máy.

## 8. Hướng phát triển

- Bổ sung kiểm thử tích hợp PostgreSQL để xác nhận transaction, lưu baseline, lưu kết quả và chống trùng trên database thực.
- Kiểm thử đầu cuối từ ESP32 qua MQTT và telemetry ingestion đến Consumer.
- Xây dựng chức năng truy vấn và hiển thị kết quả phát hiện trên dashboard.
- Tích hợp kết quả bất thường với module cảnh báo nếu yêu cầu nghiệp vụ cần thông báo cho người dùng.
- Thu thập dữ liệu cảm biến thực tế, xác định ngưỡng theo từng loại cảm biến và đánh giá tỷ lệ báo động giả.
- Nghiên cứu cơ chế khởi tạo baseline an toàn hơn để hạn chế ảnh hưởng của điểm đột biến trong giai đoạn warming-up.
- Nếu yêu cầu đồ án cần mô hình học máy, bổ sung dữ liệu huấn luyện, quy trình huấn luyện và chỉ số đánh giá riêng; không suy ra chất lượng mô hình chỉ từ unit test.

## 9. Kết luận

ADV-04 đã triển khai chức năng phát hiện dữ liệu môi trường bất thường dựa trên Median, MAD và Robust Z-score cho ba chỉ số nhiệt độ, độ ẩm và độ rọi. Hệ thống có cơ chế khởi tạo baseline, cửa sổ trượt, giải thích kết quả, lưu baseline và kết quả trong PostgreSQL, đồng thời tích hợp Consumer xử lý các sự kiện `telemetry.stored` theo cơ chế nền.

Consumer kiểm tra điều kiện dữ liệu, trạng thái thiết bị và phòng học, đối chiếu bản ghi telemetry mới nhất, tránh xử lý trùng và sử dụng transaction để hỗ trợ retry khi phát sinh lỗi. Migration `016_anomaly_detection.sql` đã được áp dụng tại môi trường local.

Theo kết quả kiểm thử local do nhóm cung cấp, **ADV-04 đạt 16/16 test và toàn bộ repository đạt 52/52 test**. Đây là kết quả unit test và consumer mock test; chưa thay thế cho kiểm thử tích hợp PostgreSQL thực tế hoặc kiểm thử đầu cuối với ESP32/MQTT. Do đó, có thể đánh giá phần triển khai code và kiểm thử tự động hiện tại đã hoàn thành, trong khi kiểm thử hệ thống thực tế và kết nối kết quả với dashboard/cảnh báo vẫn là các nội dung cần tiếp tục.
