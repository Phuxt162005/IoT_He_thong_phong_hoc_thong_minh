import test from "node:test";
import assert from "node:assert/strict";
import { AnomalyDetectionQueryService } from "../backend/src/modules/anomaly-detection/anomaly-detection-query.service.js";

function fixture() {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("SELECT count(*)")) {
        return { rows: [{ count: "1" }], rowCount: 1 };
      }

      return {
        rows: [
          {
            result_id: "501",
            device_id: "10",
            room_id: "20",
            anomaly_detected: true,
            findings: [{ metric: "temperatureC", value: 45, anomaly: true }],
          },
        ],
        rowCount: 1,
      };
    },
  };

  return { pool, queries };
}

test("list kết quả bất thường có phân trang và giới hạn theo phòng", async () => {
  const { pool, queries } = fixture();
  const service = new AnomalyDetectionQueryService(pool);

  const result = await service.list(
    { user_id: "5", role: "OPERATOR" },
    {
      page: 1,
      page_size: 20,
      room_id: "20",
      anomaly_detected: true,
    },
  );

  assert.equal(result.meta.total, 1);
  assert.equal(result.data.length, 1);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].params[0], false);
  assert.equal(queries[0].params[1], "5");
  assert.equal(queries[0].params[2], "20");
  assert.equal(queries[0].params[4], true);
});

test("Admin được truy vấn kết quả trên toàn hệ thống", async () => {
  const { pool, queries } = fixture();
  const service = new AnomalyDetectionQueryService(pool);

  await service.list(
    { user_id: "1", role: "ADMIN" },
    { page: 1, page_size: 20 },
  );

  assert.equal(queries[0].params[0], true);
});
