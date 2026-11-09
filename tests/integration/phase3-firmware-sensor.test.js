import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";
import {
  TelemetryPipeline,
  bindTelemetry,
} from "../../backend/src/modules/telemetry-ingestion/telemetry-pipeline.js";

test("PHASE 3: Sensor Node Drivers, Telemetry Ingestion, and Offline Sync Verification", async (t) => {
  const f = await iotFixture(t);

  // 1. Khởi động Telemetry Pipeline trong Backend
  const pipeline = new TelemetryPipeline({
    pool: f.pool,
    mqtt: f.runtime,
    logger: f.logger,
  });
  const unbindTelemetry = bindTelemetry(f.runtime, pipeline);
  t.after(unbindTelemetry);

  // 2. Đăng ký & Kích hoạt Sensor Node
  const sensorDevice = await f.register("SENSOR_NODE");
  const sensorCreds = (await f.action(sensorDevice.device_id, "provision")).body
    .data.credentials;
  const sensorBaseTopic = `smartclassroom/room/${f.room.room_code}/device/${sensorDevice.device_code}`;

  const sessionId = "sess-p3-test-0001";
  const acks = [];
  const configs = [];

  const sensorClient = await f.connect(sensorCreds, {
    will: {
      topic: `${sensorBaseTopic}/status`,
      payload: JSON.stringify({
        device_id: sensorDevice.device_code,
        room_id: f.room.room_code,
        session_id: sessionId,
        status: "OFFLINE",
        reason: "UNEXPECTED_DISCONNECT",
      }),
      qos: 1,
      retain: false,
    },
  });

  // Lắng nghe topic ACK của telemetry và topic Config
  sensorClient.on("message", (topic, raw) => {
    if (topic === `${sensorBaseTopic}/telemetry/ack`) {
      acks.push(JSON.parse(raw.toString()));
    } else if (topic === `${sensorBaseTopic}/config`) {
      configs.push(JSON.parse(raw.toString()));
    }
  });

  await sensorClient.subscribeAsync(`${sensorBaseTopic}/telemetry/ack`, {
    qos: 1,
  });
  await sensorClient.subscribeAsync(`${sensorBaseTopic}/config`, { qos: 1 });

  // Gửi bản tin /status ONLINE
  await sensorClient.publishAsync(
    `${sensorBaseTopic}/status`,
    JSON.stringify({
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: sessionId,
      timestamp: Date.now(),
      status: "ONLINE",
    }),
    { qos: 1 },
  );

  // Gửi heartbeat kích hoạt ban đầu
  await sensorClient.publishAsync(
    `${sensorBaseTopic}/heartbeat`,
    JSON.stringify({
      msg_id: "hb-p3-01",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: sessionId,
      timestamp: Date.now(),
      uptime_seconds: 1,
      free_heap_bytes: 220000,
      wifi_rssi_dbm: -50,
      firmware_version: "1.0.0",
    }),
    { qos: 1 },
  );

  // Chờ backend ghi nhận heartbeat của đúng phiên thiết bị
  await waitFor(async () => {
    const res = await f.pool.query(
      `SELECT connection_status, session_id, last_heartbeat_at
       FROM devices
       WHERE device_id = $1`,
      [sensorDevice.device_id],
    );

    const device = res.rows[0];

    return (
      device?.connection_status === "ONLINE" &&
      device?.session_id === sessionId &&
      device?.last_heartbeat_at !== null
    );
  });

  // Chỉ kích hoạt sau khi heartbeat đã được backend xác nhận
  const activateRes = await f.action(sensorDevice.device_id, "activate");

  assert.equal(
    activateRes.status,
    200,
    `Kích hoạt Sensor Node thất bại: ${JSON.stringify(activateRes.body)}`,
  );

  // Xác nhận thiết bị thực sự đã ACTIVE
  await waitFor(async () => {
    const res = await f.pool.query(
      `SELECT lifecycle_status
       FROM devices
       WHERE device_id = $1`,
      [sensorDevice.device_id],
    );

    return res.rows[0]?.lifecycle_status === "ACTIVE";
  });

  // ==============================================================================
  // Test Case 1: Gửi bản tin Telemetry thời gian thực (Realtime Telemetry)
  // ==============================================================================
  const now = Date.now();
  const telemetrySample1 = {
    msg_id: "tel-p3-001",
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    timestamp: now,
    data: {
      temperature: 26.5,
      humidity: 64.0,
      lux: 350,
      occupancy: true,
    },
  };

  await sensorClient.publishAsync(
    `${sensorBaseTopic}/telemetry`,
    JSON.stringify(telemetrySample1),
    { qos: 1 },
  );

  // Chờ Backend phản hồi ACK STORED
  await waitFor(() =>
    acks.some((a) => a.msg_id === "tel-p3-001" && a.status === "STORED"),
  );

  // Kiểm tra dữ liệu được lưu chính xác vào PostgreSQL
  const dbResult1 = await f.pool.query(
    "SELECT temperature, humidity, lux, occupancy FROM sensor_data WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1",
    [sensorDevice.device_id],
  );

  assert.equal(dbResult1.rowCount, 1);
  assert.equal(Number(dbResult1.rows[0].temperature), 26.5);
  assert.equal(Number(dbResult1.rows[0].humidity), 64.0);
  assert.equal(Number(dbResult1.rows[0].lux), 350);
  assert.equal(dbResult1.rows[0].occupancy, true);

  // ==============================================================================
  // Test Case 2: Mô phỏng Hàng đợi Ngoại tuyến (Offline Queue Catch-up Sync - BE-13)
  // Thiết bị lưu đệm 3 mẫu đo khi mất mạng và gửi bù tuần tự khi có mạng lại
  // ==============================================================================
  const tHistorical1 = now - 60000; // 1 phút trước
  const tHistorical2 = now - 40000; // 40 giây trước
  const tHistorical3 = now - 20000; // 20 giây trước

  const offlineBatch = [
    {
      msg_id: "tel-p3-off-01",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      timestamp: tHistorical1,
      data: { temperature: 27.0, humidity: 62.0, lux: 400, occupancy: false },
    },
    {
      msg_id: "tel-p3-off-02",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      timestamp: tHistorical2,
      data: { temperature: 27.2, humidity: 61.5, lux: 410, occupancy: true },
    },
    {
      msg_id: "tel-p3-off-03",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      timestamp: tHistorical3,
      data: { temperature: 27.1, humidity: 61.8, lux: 405, occupancy: true },
    },
  ];

  // Gửi bù toàn bộ 3 gói tin ngoại tuyến
  for (const item of offlineBatch) {
    await sensorClient.publishAsync(
      `${sensorBaseTopic}/telemetry`,
      JSON.stringify(item),
      { qos: 1 },
    );
  }

  // Chờ cả 3 gói đều nhận được ACK STORED
  await waitFor(() => {
    const ackIds = new Set(acks.map((a) => a.msg_id));
    return (
      ackIds.has("tel-p3-off-01") &&
      ackIds.has("tel-p3-off-02") &&
      ackIds.has("tel-p3-off-03")
    );
  });

  // Xác nhận tổng cộng 4 bản ghi telemetry trong database
  const countRes = await f.pool.query(
    "SELECT COUNT(*) AS total FROM sensor_data WHERE device_id = $1",
    [sensorDevice.device_id],
  );
  assert.equal(Number(countRes.rows[0].total), 4);

  // ==============================================================================
  // Test Case 3: Đổi chu kỳ lấy mẫu từ xa (Remote Sampling Interval Configuration)
  // ==============================================================================
  const configRes = await f.request(
    `/devices/${sensorDevice.device_id}/configs`,
    {
      method: "POST",
      token: f.token,
      body: {
        settings: {
          sample_interval_seconds: 3,
          heartbeat_interval_seconds: 5,
        },
      },
    },
  );

  assert.equal(configRes.status, 202);

  // Chờ thiết bị nhận được bản tin /config
  await waitFor(() => configs.length === 1);
  const receivedConfig = configs[0];
  assert.equal(receivedConfig.settings.sample_interval_seconds, 3);
  assert.equal(receivedConfig.settings.heartbeat_interval_seconds, 5);

  // Phản hồi /config/ack SUCCESS
  await sensorClient.publishAsync(
    `${sensorBaseTopic}/config/ack`,
    JSON.stringify({
      config_id: receivedConfig.config_id,
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: sessionId,
      version: receivedConfig.version,
      status: "SUCCESS",
      timestamp: Date.now(),
      applied_settings: receivedConfig.settings,
    }),
    { qos: 1 },
  );

  // Đảm bảo cấu hình mới được áp dụng trong database
  await waitFor(async () => {
    const res = await f.pool.query(
      "SELECT applied_version, applied_settings FROM device_settings WHERE device_id = $1",
      [sensorDevice.device_id],
    );
    return res.rows[0]?.applied_version === receivedConfig.version;
  });
});
