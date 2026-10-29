// Adapter đọc PostgreSQL và đổi tên trường sang mô hình shadow của module ADV-01.
// Việc ghi desired/reported do luồng command xử lý để giữ tính nguyên tử với audit và ACK.
export class PostgresDeviceShadowRepository {
  constructor(pool) { this.pool = pool; }
  async getShadow(deviceCode) {
    const row = (await this.pool.query(`SELECT s.*,d.device_code,r.room_code FROM device_shadows s JOIN devices d ON d.device_id=s.device_id
      LEFT JOIN rooms r ON r.room_id=d.room_id WHERE d.device_code=$1`, [deviceCode])).rows[0];
    if (!row) return null;
    return { deviceId: row.device_code, roomCode: row.room_code, desiredState: row.desired_state, reportedState: row.reported_state, version: row.desired_version, reportedVersion: row.reported_version, updatedAt: row.updated_at, lastReportedAt: row.last_reported_at, lastCommandError: row.last_command_error };
  }
  async getLatestCommandForDevice(deviceCode) {
    return (await this.pool.query(`SELECT c.command_id,c.device_id,c.desired_state,c.shadow_version,c.source,c.status,c.created_at,c.published_at,c.timeout_at,c.acked_at,c.error_code FROM commands c JOIN devices d ON d.device_id=c.device_id WHERE d.device_code=$1 ORDER BY c.shadow_version DESC LIMIT 1`, [deviceCode])).rows[0] ?? null;
  }
}
