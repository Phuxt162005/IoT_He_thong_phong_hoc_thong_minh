# ADV-03 --- Monitoring và Logging tập trung

## 1. Tổng quan

**Mã chức năng:** ADV-03\
**Tên chức năng:** Monitoring và Logging tập trung\
**Dự án:** Hệ thống phòng học thông minh (Smart Classroom)\
**Trạng thái:** Hoàn thành module nghiệp vụ, repository In-memory,
repository PostgreSQL và unit test. Chức năng đã có cơ chế hỗ trợ ghi
nhận sự kiện từ MQTT runtime, nhưng chưa xác nhận tích hợp đầu cuối với
toàn bộ thiết bị ESP32 và dashboard frontend.

### 1.1. Mục tiêu

Chức năng Monitoring và Logging tập trung được xây dựng nhằm hỗ trợ theo
dõi tình trạng hoạt động của các thành phần trong hệ thống phòng học
thông minh, đồng thời ghi nhận các sự kiện và lỗi phát sinh trong quá
trình vận hành.

Module cung cấp cơ chế ghi log có cấu trúc, quản lý trạng thái các thành
phần, theo dõi tình trạng kết nối thiết bị thông qua heartbeat, thống kê
số lượng sự kiện và tổng hợp thông tin giám sát. Những dữ liệu này là cơ
sở để backend theo dõi tình trạng hệ thống và hỗ trợ phát hiện sự cố.

### 1.2. Phạm vi chức năng

Phiên bản hiện tại triển khai các chức năng sau:

-   Ghi log theo bốn mức độ: `DEBUG`, `INFO`, `WARN`, `ERROR`.
-   Chuẩn hóa log thành đối tượng JSON, bao gồm timestamp, level,
    service, message và metadata.
-   Che các trường dữ liệu nhạy cảm dựa trên tên khóa, chẳng hạn
    `password`, `token`, `secret`, `authorization` và `apiKey`.
-   Hỗ trợ hai loại log sink: Console và Memory.
-   Theo dõi trạng thái các thành phần hệ thống: `UP`, `DEGRADED`,
    `DOWN`, `UNKNOWN`.
-   Ghi nhận heartbeat và xác định trạng thái online/offline dựa trên
    thời gian heartbeat gần nhất.
-   Thống kê số lượng sự kiện thông qua các counter.
-   Lưu trạng thái component và counter bằng PostgreSQL repository.
-   Đọc trạng thái thiết bị từ bảng `devices` trong PostgreSQL.
-   Tổng hợp snapshot chứa thông tin giám sát và số liệu thống kê.
-   Hỗ trợ liên kết sự kiện từ MQTT runtime với module Monitoring.

## 2. Thiết kế và nguyên lý hoạt động

### 2.1. Logging

Logging được triển khai thông qua lớp `LoggingService`. Các module
backend có thể sử dụng logger để ghi nhận sự kiện trong quá trình xử lý.

Khi nhận được yêu cầu ghi log, logger thực hiện kiểm tra mức độ log và
nội dung message, sau đó tạo đối tượng log có cấu trúc và chuyển dữ liệu
đến sink tương ứng.

Các trường thông tin chính của một bản ghi log:

  Trường        Ý nghĩa
  ------------- ----------------------------------------------
  `timestamp`   Thời điểm tạo bản ghi log
  `level`       Mức độ log: `DEBUG`, `INFO`, `WARN`, `ERROR`
  `service`     Tên dịch vụ tạo log
  `message`     Nội dung sự kiện
  `metadata`    Thông tin ngữ cảnh liên quan đến sự kiện

Module hỗ trợ hai loại sink:

-   **ConsoleLogSink:** Chuyển bản ghi log thành JSON và ghi ra console.
    Các mức `WARN`, `ERROR` được ghi qua những hàm console tương ứng.
-   **MemoryLogSink:** Lưu bản ghi log trong bộ nhớ, phục vụ việc kiểm
    thử và kiểm tra kết quả ghi log.

Trước khi ghi log, metadata được xử lý để che các trường nhạy cảm. Các
giá trị có tên khóa phù hợp với quy tắc nhận diện thông tin bí mật sẽ
được thay thế bằng `[REDACTED]`.

Ngoài ra, quá trình làm sạch dữ liệu còn giới hạn độ dài chuỗi, số phần
tử trong mảng/object và độ sâu của object lồng nhau nhằm tránh bản ghi
log quá lớn.

### 2.2. Monitoring

Chức năng Monitoring được triển khai thông qua lớp `MonitoringService`,
phối hợp với repository để quản lý và truy xuất dữ liệu giám sát.

Các thao tác chính bao gồm:

1.  Cập nhật trạng thái hoạt động của component.
2.  Ghi nhận heartbeat thiết bị trong phạm vi repository hỗ trợ.
3.  Ghi sự kiện và cập nhật counter.
4.  Tổng hợp snapshot giám sát.
5.  Liên kết sự kiện từ MQTT runtime thông qua hàm `bindMonitoring()`.

**Quản lý trạng thái component**

Các component được quản lý theo bốn trạng thái:

  Trạng thái   Ý nghĩa
  ------------ ------------------------------------------------------
  `UP`         Thành phần đang hoạt động bình thường
  `DEGRADED`   Thành phần đang hoạt động nhưng có dấu hiệu suy giảm
  `DOWN`       Thành phần không hoạt động
  `UNKNOWN`    Chưa xác định được trạng thái

Khi cập nhật trạng thái, hệ thống kiểm tra tên component, trạng thái và
thông tin chi tiết trước khi lưu vào repository. Với PostgreSQL
repository, dữ liệu được lưu trong bảng `monitoring_components` và cập
nhật bằng thao tác upsert.

**Theo dõi heartbeat thiết bị**

Heartbeat được sử dụng để xác định thiết bị có còn hoạt động trong hệ
thống hay không.

Module sử dụng thời điểm heartbeat gần nhất (`lastSeenAt`) để tính tuổi
heartbeat. Khi tạo snapshot, hệ thống so sánh khoảng thời gian này với
ngưỡng `offlineAfterMs`.

Quy tắc xác định trạng thái:

-   Thiết bị được xem là online nếu `connectionStatus` là `ONLINE`,
    heartbeat hợp lệ và tuổi heartbeat nằm trong khoảng từ 0 đến ngưỡng
    cho phép.
-   Thiết bị được xem là offline nếu không đáp ứng các điều kiện trên.

Ngưỡng mặc định hiện tại là **60.000 ms (60 giây)**.

Trong phiên bản hiện tại, repository In-memory hỗ trợ ghi nhận heartbeat
trực tiếp để phục vụ kiểm thử. Đối với trạng thái kết nối thực tế được
lưu trong PostgreSQL, trách nhiệm cập nhật heartbeat thuộc
`DevicePresenceService`; `MonitoringService` không tự ghi heartbeat vào
PostgreSQL repository.

### 2.3. Thống kê sự kiện

Module cung cấp cơ chế đếm số lượng sự kiện thông qua phương thức
`recordEvent()`.

Mỗi sự kiện được xác định bằng một tên counter. Khi nhận được yêu cầu,
hệ thống kiểm tra tên counter, số lượng cần tăng, mức log, message và
metadata. Nếu dữ liệu hợp lệ, hệ thống tăng counter tương ứng và ghi
nhận sự kiện vào logger.

Ví dụ:

-   `telemetry.received`: số lượng sự kiện telemetry được tiếp nhận.
-   `mqtt.telemetry.received`: số lượng sự kiện telemetry nhận từ MQTT
    runtime thông qua cơ chế liên kết Monitoring.

Đối với PostgreSQL repository, counter được lưu trong bảng
`monitoring_counters`. Việc tăng counter sử dụng câu lệnh
`INSERT ... ON CONFLICT DO UPDATE`, giúp cập nhật giá trị hiện tại mà
không cần tách riêng thao tác kiểm tra và thêm mới.

### 2.4. Liên kết sự kiện MQTT

Module cung cấp hàm `bindMonitoring(runtime, monitoring)` để đăng ký
lắng nghe sự kiện `device-message` từ MQTT runtime.

Khi nhận được sự kiện, hàm này gọi `recordEvent()` để cập nhật counter
theo loại thông điệp. Metadata ghi nhận các thông tin như mã phòng, mã
thiết bị và loại thông điệp.

Nếu quá trình ghi nhận sự kiện Monitoring gặp lỗi, module ghi cảnh báo
tương ứng thay vì để lỗi của chức năng giám sát chặn handler nghiệp vụ
MQTT.

Hàm này cung cấp cơ chế liên kết giữa MQTT runtime và Monitoring. Việc
hệ thống thực tế đã đăng ký và vận hành liên kết này cần được xác nhận
riêng khi kiểm tra luồng tích hợp.

### 2.5. Snapshot giám sát

`getSnapshot()` tổng hợp dữ liệu từ repository và trả về trạng thái giám
sát tại thời điểm được yêu cầu.

Snapshot bao gồm:

  Trường          Ý nghĩa
  --------------- --------------------------------------------------------
  `generatedAt`   Thời điểm tạo snapshot
  `components`    Danh sách trạng thái các component
  `devices`       Danh sách thiết bị cùng thông tin kết nối và heartbeat
  `counters`      Tổng số sự kiện theo từng counter
  `summary`       Các số liệu tổng hợp của hệ thống

Trong đó, `summary` cung cấp:

-   `componentCount`: tổng số component.
-   `componentUp`: số component đang hoạt động bình thường.
-   `componentDegraded`: số component đang suy giảm.
-   `componentDown`: số component không hoạt động.
-   `deviceCount`: tổng số thiết bị.
-   `deviceOnline`: số thiết bị online.
-   `deviceOffline`: số thiết bị offline.

Snapshot được cung cấp ở mức service. Phiên bản hiện tại chưa xác nhận
có API hoặc giao diện dashboard riêng để hiển thị snapshot cho người
dùng.

## 3. Cấu trúc source code

``` text
source code IoT/
├── package.json
├── tests/
│   └── monitoring-logging.test.js
└── backend/
    └── src/
        └── modules/
            └── monitoring-logging/
                ├── monitoring.errors.js
                ├── monitoring.service.js
                ├── monitoring.repository.memory.js
                ├── monitoring.repository.postgres.js
                ├── logging.service.js
                └── logging.sinks.js
```

## 4. Trách nhiệm của từng file

  -------------------------------------------------------------------------
  File                                  Trách nhiệm
  ------------------------------------- -----------------------------------
  `monitoring.errors.js`                Định nghĩa `MonitoringError`, cung
                                        cấp thông báo và mã lỗi cho các
                                        trường hợp lỗi thuộc module
                                        Monitoring.

  `logging.service.js`                  Kiểm tra log level và message, tạo
                                        bản ghi log có cấu trúc, làm sạch
                                        metadata và che dữ liệu nhạy cảm.

  `logging.sinks.js`                    Cung cấp `ConsoleLogSink` để ghi
                                        log ra console và `MemoryLogSink`
                                        để lưu log trong bộ nhớ.

  `monitoring.repository.memory.js`     Repository In-memory, lưu trạng
                                        thái component, heartbeat thiết bị
                                        và counter; chủ yếu phục vụ kiểm
                                        thử độc lập.

  `monitoring.repository.postgres.js`   Repository PostgreSQL, lưu và truy
                                        xuất trạng thái component, counter;
                                        đọc trạng thái thiết bị từ bảng
                                        `devices`.

  `monitoring.service.js`               Xử lý nghiệp vụ Monitoring, cập
                                        nhật trạng thái component, ghi nhận
                                        heartbeat trong phạm vi repository
                                        hỗ trợ, thống kê sự kiện, tạo
                                        snapshot và cung cấp hàm liên kết
                                        sự kiện MQTT.

  `monitoring-logging.test.js`          Kiểm thử Logging, Monitoring,
                                        heartbeat, counter, xác thực dữ
                                        liệu và các thao tác của PostgreSQL
                                        repository.

  `package.json`                        Khai báo script
                                        `test:monitoring-logging` để chạy
                                        bộ kiểm thử ADV-03.
  -------------------------------------------------------------------------

## 5. Xử lý dữ liệu và lỗi

### 5.1. Kiểm tra và làm sạch dữ liệu Logging

Logger từ chối các yêu cầu có log level không được hỗ trợ hoặc message
rỗng.

Metadata được làm sạch trước khi ghi log:

-   Che các trường có tên khóa liên quan đến mật khẩu, token, secret,
    authorization và API key.
-   Giới hạn độ dài chuỗi.
-   Giới hạn số lượng phần tử trong mảng và object.
-   Giới hạn độ sâu của object lồng nhau.

Các trường dữ liệu nhạy cảm được thay thế bằng `[REDACTED]` trước khi
chuyển đến sink.

### 5.2. Kiểm tra dữ liệu Monitoring

Module thực hiện xác thực dữ liệu đầu vào trước khi xử lý.

Các trường hợp không hợp lệ bị từ chối bao gồm:

-   Tên component rỗng.
-   Trạng thái component không thuộc tập trạng thái được hỗ trợ.
-   `details` không phải object hợp lệ.
-   `deviceId` rỗng.
-   Timestamp heartbeat không hợp lệ.
-   Tên counter rỗng.
-   `amount` không phải số nguyên dương.
-   Log level không hợp lệ.
-   Message rỗng.
-   Metadata không phải object hợp lệ.

Đặc biệt, trong `recordEvent()`, dữ liệu được xác thực trước khi cập
nhật counter. Vì vậy, yêu cầu có log level không hợp lệ sẽ không làm
thay đổi giá trị counter.

### 5.3. Phân biệt trạng thái kết nối và trạng thái vòng đời thiết bị

Module phân biệt hai thông tin:

-   `connectionStatus`: trạng thái kết nối của thiết bị, ví dụ `ONLINE`.
-   `lifecycleStatus`: trạng thái vòng đời thiết bị, ví dụ `ACTIVE`.

Việc thiết bị có được xem là online trong snapshot hay không còn phụ
thuộc vào thời điểm heartbeat gần nhất và ngưỡng thời gian cấu hình.

Đối với PostgreSQL repository, danh sách thiết bị được truy vấn từ bảng
`devices`; những thiết bị có vòng đời `REVOKED` hoặc `DECOMMISSIONED`
không được đưa vào kết quả truy vấn.

## 6. Kiểm thử

### 6.1. Lệnh chạy

Chạy riêng bộ kiểm thử ADV-03 tại thư mục gốc repository:

``` powershell
npm run test:monitoring-logging
```

Chạy toàn bộ unit test của các module:

``` powershell
npm test
```

### 6.2. Các trường hợp đã kiểm thử

Bộ kiểm thử hiện tại gồm 12 trường hợp:

  ------------------------------------------------------------------------
                           STT Trường hợp kiểm thử   Kết quả
  ---------------------------- --------------------- ---------------------
                             1 Logger ghi log JSON   PASS
                               có cấu trúc           

                             2 Logger che trường     PASS
                               nhạy cảm              

                             3 Từ chối log level và  PASS
                               message không hợp lệ  

                             4 Cập nhật trạng thái   PASS
                               component             

                             5 Heartbeat được tính   PASS
                               online và chuyển      
                               offline khi quá       
                               ngưỡng                

                             6 Đếm sự kiện và ghi    PASS
                               log tương ứng         

                             7 Từ chối heartbeat     PASS
                               timestamp không hợp   
                               lệ                    

                             8 Từ chối trạng thái    PASS
                               component và amount   
                               không hợp lệ          

                             9 Không tăng counter    PASS
                               khi log level không   
                               hợp lệ                

                            10 PostgreSQL repository PASS
                               lưu trạng thái        
                               component             

                            11 PostgreSQL repository PASS
                               đọc trạng thái thiết  
                               bị từ bảng `devices`  

                            12 PostgreSQL repository PASS
                               tăng counter bằng     
                               thao tác upsert       
  ------------------------------------------------------------------------

### 6.3. Kết quả kiểm thử thực tế

Kết quả chạy local do người dùng cung cấp:

``` text
tests 12
suites 0
pass 12
fail 0
cancelled 0
skipped 0
todo 0
```

**Kết quả: 12/12 test PASS.**

Kết quả trên xác nhận toàn bộ 12 trường hợp kiểm thử của module ADV-03
đã chạy thành công tại local.

Cần lưu ý: Các test PostgreSQL hiện sử dụng đối tượng `pool` giả lập để
kiểm tra câu lệnh SQL và dữ liệu trả về. Vì vậy, kết quả này chưa chứng
minh toàn bộ thao tác đã được kiểm thử trực tiếp trên PostgreSQL đang
chạy.

## 7. Hạn chế hiện tại

Mặc dù module đã có repository PostgreSQL và bộ unit test đầy đủ, vẫn
còn một số giới hạn cần được xử lý trong quá trình tích hợp:

1.  **Chưa có hệ thống lưu trữ log chuyên dụng:** Console sink ghi log
    ra console, Memory sink lưu log trong bộ nhớ. Chưa triển khai kho
    lưu trữ log riêng, cơ chế tìm kiếm và chính sách xoay vòng log.
2.  **Chưa xác nhận tích hợp đầy đủ với MQTT runtime:** Đã có hàm
    `bindMonitoring()` hỗ trợ lắng nghe sự kiện `device-message`, nhưng
    cần kiểm tra việc đăng ký hàm này trong luồng khởi tạo backend.
3.  **Chưa xác nhận luồng heartbeat đầu cuối:** Repository PostgreSQL
    đọc trạng thái thiết bị từ bảng `devices`, còn việc cập nhật trạng
    thái kết nối thực tế thuộc trách nhiệm của `DevicePresenceService`.
4.  **Chưa kiểm thử trực tiếp PostgreSQL trong bộ test ADV-03:** Các
    test repository hiện sử dụng pool giả lập, chưa kiểm chứng truy vấn
    trên cơ sở dữ liệu thực.
5.  **Chưa tích hợp dashboard frontend:** Snapshot hiện được cung cấp ở
    mức service, chưa có giao diện giám sát dành cho người dùng.
6.  **Che dữ liệu nhạy cảm còn giới hạn:** Cơ chế hiện tại dựa trên tên
    khóa, do đó không bảo đảm phát hiện mọi thông tin nhạy cảm nằm trong
    nội dung message tự do.
7.  **Ngưỡng offline mới là giá trị mặc định:** Ngưỡng 60 giây cần được
    đánh giá lại theo chu kỳ heartbeat và điều kiện mạng thực tế của
    từng loại thiết bị.

## 8. Hướng tích hợp tiếp theo

Để hoàn thiện ADV-03 trong hệ thống phòng học thông minh, có thể thực
hiện các công việc sau:

-   Kết nối `LoggingService` với các module backend để ghi nhận
    telemetry, lệnh điều khiển, ACK và lỗi vận hành.
-   Đăng ký `bindMonitoring()` trong quá trình khởi tạo MQTT runtime nếu
    phù hợp với luồng sự kiện thực tế.
-   Kết nối Monitoring với `DevicePresenceService` để lấy trạng thái kết
    nối thiết bị được cập nhật từ heartbeat thực tế.
-   Kiểm thử PostgreSQL repository trực tiếp trên cơ sở dữ liệu được
    khởi tạo từ Docker Compose.
-   Bổ sung cơ chế lưu trữ và truy vấn log khi cần quản lý lịch sử vận
    hành.
-   Cung cấp snapshot thông qua cơ chế giao tiếp backend đã thống nhất
    để frontend có thể hiển thị thông tin giám sát.
-   Bổ sung kiểm thử tích hợp giữa MQTT Broker, backend, PostgreSQL và
    thiết bị IoT.

## 9. Kết luận

ADV-03 --- Monitoring và Logging tập trung đã xây dựng được module hỗ
trợ ghi nhật ký có cấu trúc và theo dõi tình trạng hoạt động của các
thành phần trong hệ thống phòng học thông minh.

Module hiện hỗ trợ ghi log theo mức độ, che một số trường dữ liệu nhạy
cảm, quản lý trạng thái component, theo dõi heartbeat, thống kê sự kiện,
tạo snapshot giám sát và cung cấp repository để làm việc với PostgreSQL.

Bộ kiểm thử hiện tại gồm **12 trường hợp và cả 12 đều PASS** trong lần
chạy local được ghi nhận. Trong đó, các chức năng Logging, Monitoring cơ
bản, heartbeat, counter và các thao tác repository PostgreSQL đã có kiểm
thử tương ứng.

Như vậy, ADV-03 được xác nhận hoàn thành ở mức **module nghiệp vụ và
unit test**. Việc tích hợp đầu cuối với MQTT runtime, heartbeat thiết bị
thực tế, PostgreSQL thực và dashboard frontend sẽ tiếp tục được thực
hiện trong các giai đoạn tích hợp hệ thống.
