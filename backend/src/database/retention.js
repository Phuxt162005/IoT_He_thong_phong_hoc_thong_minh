import { withTransaction } from "./pool.js";
import { writeAudit } from "./audit.js";

// Dọn dữ liệu đo/sự kiện hết hạn theo từng đợt; giữ nguyên audit và lịch sử nghiệp vụ.
// Hàm chạy một lượt; server chỉ lên lịch tự động khi RETENTION_ENABLED được bật.
export async function runRetention(pool, { sensorDays = 90, eventDays = 7, batchSize = 1000 } = {}) {
  if (![sensorDays, eventDays, batchSize].every(Number.isSafeInteger) || sensorDays < 1 || sensorDays > 3650 || eventDays < 1 || eventDays > sensorDays || batchSize < 1 || batchSize > 10000) throw new TypeError("Cấu hình retention không hợp lệ");
  return withTransaction(pool, async (client) => {
    // LIMIT giới hạn số mẫu mỗi đợt; SKIP LOCKED bỏ qua hàng đang được tác vụ khác giữ khóa.
    // Tuổi dữ liệu đo tính theo recorded_at, còn tuổi sự kiện tính theo created_at.
    const samples = await client.query(`WITH doomed AS (SELECT data_id FROM sensor_data WHERE recorded_at<clock_timestamp()-($1::double precision * interval '1 day') ORDER BY data_id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM sensor_data s USING doomed d WHERE s.data_id=d.data_id`, [sensorDays, batchSize]);
    const events = await client.query(`WITH doomed AS (SELECT event_id FROM iot_events WHERE created_at<clock_timestamp()-($1::double precision * interval '1 day') ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM iot_events e USING doomed d WHERE e.event_id=d.event_id`, [eventDays, batchSize]);
    // Dọn bộ đếm/khóa chống lặp đã hết hiệu lực; không xóa bản ghi command gốc.
    await client.query("DELETE FROM command_idempotency WHERE expires_at<now()-interval '1 day'");
    await client.query("DELETE FROM login_attempts WHERE window_started<now()-interval '1 day'");
    await client.query("DELETE FROM api_rate_limits WHERE window_started<now()-interval '1 day'");
    const result = { sensor_data_deleted: samples.rowCount, iot_events_deleted: events.rowCount, sensor_days: sensorDays, event_days: eventDays };
    // Ghi số lượng đã xóa cùng transaction; nếu audit lỗi thì toàn bộ lượt dọn được rollback.
    if (samples.rowCount || events.rowCount) await writeAudit(client, { action: "DATA_RETENTION", targetType: "SYSTEM", details: result });
    return result;
  });
}
