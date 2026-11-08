import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";

test("PHASE 2: RemoteConfigManager simulation for Sensor Node and Control Node", async (t) => {
  const f = await iotFixture(t);

  // 1. Đăng ký & Kích hoạt Sensor Node
  const sensorDevice = await f.register("SENSOR_NODE");
  const sensorCreds = (await f.action(sensorDevice.device_id, "provision")).body.data.credentials;
  const sensorBaseTopic = `smartclassroom/room/${f.room.room_code}/device/${sensorDevice.device_code}`;

  const sessionId = "sess-p2-test-0001";
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

  // Gửi ONLINE status và heartbeat ban đầu
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

  await sensorClient.publishAsync(
    `${sensorBaseTopic}/heartbeat`,
    JSON.stringify({
      msg_id: "hb-p2-01",
      device_id: sensorDevice.device_code,
      room_id: f.room.room_code,
      session_id: sessionId,
      timestamp: Date.now(),
      uptime_seconds: 10,
      free_heap_bytes: 185000,
      wifi_rssi_dbm: -55,
      firmware_version: "1.0.0",
    }),
    { qos: 0 },
  );

  await f.action(sensorDevice.device_id, "activate");

  // 2. Thiết bị đăng ký nhận topic config
  const receivedConfigs = [];
  sensorClient.on("message", async (topic, raw) => {
    if (topic === `${sensorBaseTopic}/config`) {
      const msg = JSON.parse(raw.toString());
      receivedConfigs.push(msg);

      // Mô phỏng RemoteConfigManager.handleMessage:
      // Kiểm tra tính hợp lệ và gửi lại ACK SUCCESS
      const ackPayload = JSON.stringify({
        config_id: msg.config_id,
        device_id: msg.device_id,
        room_id: msg.room_id,
        session_id: msg.session_id,
        version: msg.version,
        status: "SUCCESS",
        timestamp: Date.now(),
        applied_settings: msg.settings,
      });

      await sensorClient.publishAsync(`${sensorBaseTopic}/config/ack`, ackPayload, { qos: 1 });
    }
  });

  await sensorClient.subscribeAsync(`${sensorBaseTopic}/config`, { qos: 1 });

  // 3. Admin gửi yêu cầu thay đổi cấu hình từ xa (BE-11)
  const configRes = await f.request(`/devices/${sensorDevice.device_id}/configs`, {
    method: "POST",
    token: f.token,
    body: {
      settings: {
        sample_interval_seconds: 3,
        heartbeat_interval_seconds: 5,
      },
    },
  });

  assert.equal(configRes.status, 202, "Backend phải tiếp nhận cấu hình với HTTP 202 PENDING");
  const createdConfig = configRes.body.data;
  assert.equal(createdConfig.version, 1);

  // Đợi thiết bị nhận được cấu hình và gửi ACK
  await waitFor(() => receivedConfigs.length === 1);
  assert.equal(receivedConfigs[0].config_id, createdConfig.config_id);
  assert.equal(receivedConfigs[0].session_id, sessionId);

  // Kiểm tra backend đã cập nhật applied_version lên 1
  await waitFor(async () => {
    const row = (await f.pool.query("SELECT applied_version, applied_settings FROM device_settings WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
    return row.applied_version === 1 && row.applied_settings.sample_interval_seconds === 3;
  });

  // 4. Kiểm tra chống gửi lặp (Deduplication)
  // Gửi lại ACK của version 1 (mô phỏng thiết bị khởi động lại hoặc nhận trùng)
  const dupAckPayload = JSON.stringify({
    config_id: createdConfig.config_id,
    device_id: sensorDevice.device_code,
    room_id: f.room.room_code,
    session_id: sessionId,
    version: 1,
    status: "SUCCESS",
    timestamp: Date.now(),
    applied_settings: { sample_interval_seconds: 3, heartbeat_interval_seconds: 5 },
  });
  await sensorClient.publishAsync(`${sensorBaseTopic}/config/ack`, dupAckPayload, { qos: 1 });

  // applied_version vẫn giữ nguyên 1, không bị lỗi
  const settingsRow = (await f.pool.query("SELECT applied_version FROM device_settings WHERE device_id=$1", [sensorDevice.device_id])).rows[0];
  assert.equal(settingsRow.applied_version, 1);

  // 5. Kiểm tra với Control Node
  const controlDevice = await f.register("CONTROL_NODE");
  const controlCreds = (await f.action(controlDevice.device_id, "provision")).body.data.credentials;
  const controlBaseTopic = `smartclassroom/room/${f.room.room_code}/device/${controlDevice.device_code}`;

  const ctrlSession = "sess-ctrl-p2";
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

  await controlClient.publishAsync(
    `${controlBaseTopic}/status`,
    JSON.stringify({
      device_id: controlDevice.device_code,
      room_id: f.room.room_code,
      session_id: ctrlSession,
      timestamp: Date.now(),
      status: "ONLINE",
      reported_state: { fan: "OFF", light: "OFF" },
      shadow_version: 1,
    }),
    { qos: 1 },
  );

  await controlClient.publishAsync(
    `${controlBaseTopic}/heartbeat`,
    JSON.stringify({
      msg_id: "hb-ctrl-p2",
      device_id: controlDevice.device_code,
      room_id: f.room.room_code,
      session_id: ctrlSession,
      timestamp: Date.now(),
      uptime_seconds: 10,
      free_heap_bytes: 190000,
      wifi_rssi_dbm: -50,
      firmware_version: "1.0.0",
    }),
    { qos: 0 },
  );

  await f.action(controlDevice.device_id, "activate");

  controlClient.on("message", async (topic, raw) => {
    if (topic === `${controlBaseTopic}/config`) {
      const msg = JSON.parse(raw.toString());
      await controlClient.publishAsync(
        `${controlBaseTopic}/config/ack`,
        JSON.stringify({
          config_id: msg.config_id,
          device_id: msg.device_id,
          room_id: msg.room_id,
          session_id: msg.session_id,
          version: msg.version,
          status: "SUCCESS",
          timestamp: Date.now(),
          applied_settings: msg.settings,
        }),
        { qos: 1 },
      );
    }
  });

  await controlClient.subscribeAsync(`${controlBaseTopic}/config`, { qos: 1 });

  // Control Node chỉ hỗ trợ heartbeat_interval_seconds, gửi sample_interval_seconds sẽ bị từ chối
  const badConfig = await f.request(`/devices/${controlDevice.device_id}/configs`, {
    method: "POST",
    token: f.token,
    body: { settings: { sample_interval_seconds: 4 } },
  });
  assert.equal(badConfig.status, 400, "Control node phải từ chối cấu hình sample_interval_seconds");

  // Gửi cấu hình heartbeat_interval_seconds hợp lệ cho Control Node
  const goodCtrlConfig = await f.request(`/devices/${controlDevice.device_id}/configs`, {
    method: "POST",
    token: f.token,
    body: { settings: { heartbeat_interval_seconds: 8 } },
  });
  assert.equal(goodCtrlConfig.status, 202);

  await waitFor(async () => {
    const row = (await f.pool.query("SELECT applied_version, applied_settings FROM device_settings WHERE device_id=$1", [controlDevice.device_id])).rows[0];
    return row.applied_version === 1 && row.applied_settings.heartbeat_interval_seconds === 8;
  });

  await sensorClient.endAsync();
  await controlClient.endAsync();
});

