export class PostgresMonitoringRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new TypeError("Cần PostgreSQL pool");
    }
    this.pool = pool;
  }

  async setComponent(
    name,
    status,
    details = {},
    timestamp = new Date().toISOString(),
  ) {
    const result = await this.pool.query(
      `INSERT INTO monitoring_components(name,status,details,updated_at)
       VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT(name) DO UPDATE SET
         status=EXCLUDED.status,
         details=EXCLUDED.details,
         updated_at=EXCLUDED.updated_at
       RETURNING name,status,details,updated_at`,
      [name, status, JSON.stringify(details), timestamp],
    );
    const row = result.rows[0];
    return {
      name: row.name,
      status: row.status,
      details: row.details,
      updatedAt: row.updated_at,
    };
  }

  async getComponents() {
    const result = await this.pool.query(
      "SELECT name,status,details,updated_at FROM monitoring_components ORDER BY name",
    );
    return result.rows.map((row) => ({
      name: row.name,
      status: row.status,
      details: row.details,
      updatedAt: row.updated_at,
    }));
  }

  async getDevices() {
    const result = await this.pool.query(
      `SELECT device_code AS "deviceId",
              connection_status AS "connectionStatus",
              lifecycle_status AS "lifecycleStatus",
              last_seen AS "lastSeenAt",
              room_id AS "roomId"
       FROM devices
       WHERE lifecycle_status NOT IN ('REVOKED','DECOMMISSIONED')
       ORDER BY device_code`,
    );
    return result.rows;
  }

  async incrementCounter(name, amount = 1) {
    const result = await this.pool.query(
      `INSERT INTO monitoring_counters(name,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(name) DO UPDATE SET
         value=monitoring_counters.value+EXCLUDED.value,
         updated_at=now()
       RETURNING value`,
      [name, amount],
    );
    return Number(result.rows[0].value);
  }

  async getCounters() {
    const result = await this.pool.query(
      "SELECT name,value FROM monitoring_counters ORDER BY name",
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.name, Number(row.value)]),
    );
  }

  async getLogs({ page = 1, pageSize = 20, level, service, search, from, to }) {
    const params = [];
    const conditions = [];

    if (level) {
      params.push(level);
      conditions.push(`level=$${params.length}`);
    }

    if (service) {
      params.push(service);
      conditions.push(`service=$${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`message ILIKE $${params.length}`);
    }

    if (from) {
      params.push(from);
      conditions.push(`logged_at >= $${params.length}`);
    }

    if (to) {
      params.push(to);
      conditions.push(`logged_at < $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalResult = await this.pool.query(
      `SELECT count(*)::bigint AS total FROM monitoring_logs ${where}`,
      params,
    );

    const total = Number(totalResult.rows[0].total);

    params.push(pageSize);
    const limitPosition = params.length;

    params.push((page - 1) * pageSize);
    const offsetPosition = params.length;

    const result = await this.pool.query(
      `SELECT log_id,logged_at,level,service,message,metadata
       FROM monitoring_logs
       ${where}
       ORDER BY logged_at DESC,log_id DESC
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      params,
    );

    return {
      items: result.rows.map((row) => ({
        logId: String(row.log_id),
        timestamp: row.logged_at,
        level: row.level,
        service: row.service,
        message: row.message,
        metadata: row.metadata,
      })),
      total,
      page,
      pageSize,
    };
  }
}
