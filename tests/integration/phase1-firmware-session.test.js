import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";

test("PHASE 1: NodeSessionManager simulation for Sensor Node and Control Node", async (t) => {
  const f = await iotFixture(t);

  // 1. Đăng ký và Provision Sensor Node
  const sensorDevice = await f.register("SENSOR_NODE");
  const sensorCreds = (await f.action(sensorDevice.device_id, "provision")).body.data.credentials;
  const sensorBaseTopic = `smartclassroom/room/${f.room.room_code}/device/${sensorDevice.device_code}`;

  // 2. Mô phỏng NodeSessionManager kết nối MQTT lần đầu (Session 1)
  const session1 = "sess-00000001-00000001";
  const sensorLwtPayload = JSON.stringify({
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    session_id: session1,
    status: "OFFLINE",
    reason: "UNEXPECTED_DISCONNECT",
  });

  const sensorClient = await f.connect(sensorCreds, {
    will: {
      topic: `${sensorBaseTopic}/status`,
      payload: sensorLwtPayload,
      qos: 1,
      retain: false,
    },
  });

  // 3. NodeSessionManager gửi ONLINE status ngay sau khi có NTP
  const onlinePayload = JSON.stringify({
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    session_id: session1,
    timestamp: Date.now(),
    status: "ONLINE",
  });
  await sensorClient.publishAsync(`${sensorBaseTopic}/status`, onlinePayload, { qos: 1 });

  // Kiểm tra thiết bị đã chuyển ONLINE trong DB
  await waitFor(async () => {
    const row = (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.connection_status === "ONLINE";
  });

  // 4. NodeSessionManager gửi Heartbeat đầu tiên
  const hb1Payload = JSON.stringify({
    msg_id: "hb-00000001-00000001",
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    session_id: session1,
    timestamp: Date.now(),
    uptime_seconds: 10,
    free_heap_bytes: 185000,
    wifi_rssi_dbm: -58,
    firmware_version: "1.0.0",
  });
  await sensorClient.publishAsync(`${sensorBaseTopic}/heartbeat`, hb1Payload, { qos: 0 });

  // Kiểm tra chẩn đoán heartbeat trong database
  await waitFor(async () => {
    const row = (await f.pool.query("SELECT last_uptime_seconds, last_free_heap_bytes, last_rssi_dbm FROM devices WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.last_uptime_seconds === "10" && row.last_free_heap_bytes === "185000" && row.last_rssi_dbm === -58;
  });

  // Kích hoạt thiết bị (Activate) - Cần có heartbeat của session hiện tại mới kích hoạt thành công
  const activateRes = await f.action(sensorDevice.device_id, "activate");
  assert.equal(activateRes.status, 200, "Device phải kích hoạt thành công khi đã có heartbeat hợp lệ");

  // 5. NodeSessionManager gửi Heartbeat thứ hai (uptime_seconds tăng lên 20)
  const hb2Payload = JSON.stringify({
    msg_id: "hb-00000001-00000002",
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    session_id: session1,
    timestamp: Date.now(),
    uptime_seconds: 20,
    free_heap_bytes: 184500,
    wifi_rssi_dbm: -59,
    firmware_version: "1.0.0",
  });
  await sensorClient.publishAsync(`${sensorBaseTopic}/heartbeat`, hb2Payload, { qos: 0 });

  await waitFor(async () => {
    const row = (await f.pool.query("SELECT last_uptime_seconds FROM devices WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.last_uptime_seconds === "20";
  });

  // 6. Kiểm tra cơ chế LWT khi mất kết nối đột ngột
  sensorClient.stream.destroy();
  await waitFor(async () => {
    const row = (await f.pool.query("SELECT connection_status FROM devices WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.connection_status === "OFFLINE";
  });

  // 7. NodeSessionManager tự động Reconnect với Session ID mới (Session 2)
  const session2 = "sess-00000002-00000001";
  const sensorClient2 = await f.connect(sensorCreds, {
    will: {
      topic: `${sensorBaseTopic}/status`,
      payload: JSON.stringify({
        device_id: sensorDevice.device_code,
        room_id: f.room.room_code,
        session_id: session2,
        status: "OFFLINE",
        reason: "UNEXPECTED_DISCONNECT",
      }),
      qos: 1,
      retain: false,
    },
  });

  await sensorClient2.publishAsync(
    `${sensorBaseTopic}/status`,
    JSON.stringify({
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: session2,
      timestamp: Date.now(),
      status: "ONLINE",
    }),
    { qos: 1 },
  );

  await sensorClient2.publishAsync(
    `${sensorBaseTopic}/heartbeat`,
    JSON.stringify({
      msg_id: "hb-00000002-00000001",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: session2,
      timestamp: Date.now(),
      uptime_seconds: 35,
      free_heap_bytes: 182000,
      wifi_rssi_dbm: -55,
      firmware_version: "1.0.0",
    }),
    { qos: 0 },
  );

  await waitFor(async () => {
    const row = (await f.pool.query("SELECT session_id, connection_status FROM devices WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.session_id === session2 && row.connection_status === "ONLINE";
  });

  // Đảm bảo session cũ (session1) đã được đóng trong device_sessions
  const closedSession = (await f.pool.query("SELECT closed_at FROM device_sessions WHERE device_id=$1 AND session_id=$2", [sensorDevice.device_id, session1])).rows[0];
  assert.ok(closedSession.closed_at, "Phiên cũ phải được đánh dấu closed_at");

  await sensorClient2.endAsync();

  // 8. Mô phỏng Control Node với Extra Status Hook (reported_state & shadow_version)
  const controlDevice = await f.register("CONTROL_NODE");
  const controlCreds = (await f.action(controlDevice.device_id, "provision")).body.data.credentials;
  const controlBaseTopic = `smartclassroom/room/${f.room.room_code}/device/${controlDevice.device_code}`;

  const ctrlSession = "sess-ctrl-00000001";
  const controlClient = await f.connect(controlCreds, {
    will: {
      topic: `${controlBaseTopic}/status`,
      payload: JSON.stringify({
        device_id: controlDevice.device_code,
        room_id: f.room.room_code,
        session_id: ctrlSession,
        status: "OFFLINE",
        reason: "UNEXPECTED_DISCONNECT",
      }),
      qos: 1,
      retain: false,
    },
  });

  // Control Node publish ONLINE status kèm reported snapshot
  const ctrlOnlinePayload = JSON.stringify({
    device_id: controlDevice.device_code,
    room_id: f.room.room_code,
    session_id: ctrlSession,
    timestamp: Date.now(),
    status: "ONLINE",
    reported_state: { fan: "OFF", light: "OFF" },
    shadow_version: 1,
  });
  await controlClient.publishAsync(`${controlBaseTopic}/status`, ctrlOnlinePayload, { qos: 1 });

  // Control Node gửi heartbeat
  await controlClient.publishAsync(
    `${controlBaseTopic}/heartbeat`,
    JSON.stringify({
      msg_id: "hb-ctrl-001",
      device_id: controlDevice.device_code,
      room_id: f.room.room_code,
      session_id: ctrlSession,
      timestamp: Date.now(),
      uptime_seconds: 15,
      free_heap_bytes: 190000,
      wifi_rssi_dbm: -50,
      firmware_version: "1.0.0",
    }),
    { qos: 0 },
  );

  await waitFor(async () => {
    const row = (await f.pool.query("SELECT last_heartbeat_at FROM devices WHERE device_id=$1", [controlDevice.device_id])).rows[0];
    return Boolean(row?.last_heartbeat_at);
  });

  // Kích hoạt Control Node
  const ctrlActivate = await f.action(controlDevice.device_id, "activate");
  assert.equal(ctrlActivate.status, 200, "Control node phải kích hoạt thành công");

  await waitFor(async () => {
    const row = (await f.pool.query("SELECT connection_status, session_id FROM devices WHERE device_id=$1", [controlDevice.device_id])).rows[0];
    return row.connection_status === "ONLINE" && row.session_id === ctrlSession;
  });

  await controlClient.endAsync();
});
