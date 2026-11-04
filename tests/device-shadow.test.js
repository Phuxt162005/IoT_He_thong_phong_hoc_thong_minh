import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryDeviceShadowRepository } from "../backend/src/modules/device-shadow/device-shadow.repository.memory.js";
import {
  DeviceShadowService,
  validateStatePatch,
} from "../backend/src/modules/device-shadow/device-shadow.service.js";
import { buildDeviceCommandTopic } from "../backend/src/modules/device-shadow/device-shadow.mqtt.js";

function fixture() {
  const repository = new InMemoryDeviceShadowRepository();

  const service = new DeviceShadowService({ repository });

  return { repository, service };
}

test("tạo Device Shadow với trạng thái ban đầu", async () => {
  const { repository, service } = fixture();

  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  const shadow = await service.getShadow("CTRL_01");

  assert.equal(shadow.desiredState.fan, "OFF");
  assert.equal(shadow.reportedState.fan, "OFF");
  assert.equal(shadow.inSync, true);
  assert.deepEqual(shadow.differences, {});
});

test("phát hiện chênh lệch giữa desired state và reported state", async () => {
  const { repository, service } = fixture();

  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  await repository.saveShadow({
    ...(await repository.getShadow("CTRL_01")),
    desiredState: { light: "OFF", fan: "ON" },
  });

  const shadow = await service.getShadow("CTRL_01");

  assert.equal(shadow.inSync, false);
  assert.deepEqual(shadow.differences, {
    fan: { desired: "ON", reported: "OFF" },
  });
});

test("reported state UNKNOWN được xác định là chưa đồng bộ", async () => {
  const { repository, service } = fixture();

  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  await repository.saveShadow({
    ...(await repository.getShadow("CTRL_01")),
    reportedState: { light: "UNKNOWN", fan: "UNKNOWN" },
  });

  const shadow = await service.getShadow("CTRL_01");

  assert.equal(shadow.inSync, false);
  assert.equal(shadow.differences.light.reported, "UNKNOWN");
  assert.equal(shadow.differences.fan.reported, "UNKNOWN");
});

test("lấy thông tin lệnh điều khiển gần nhất", async () => {
  const { repository, service } = fixture();

  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  await repository.saveCommand({
    commandId: "CMD_001",
    deviceId: "CTRL_01",
    status: "PENDING",
    createdAt: "2026-10-28T10:00:00.000Z",
  });

  const shadow = await service.getShadow("CTRL_01");

  assert.equal(shadow.latestCommand.commandId, "CMD_001");
  assert.equal(shadow.latestCommand.status, "PENDING");
});

test("báo lỗi khi không tìm thấy Device Shadow", async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.getShadow("UNKNOWN_DEVICE"),
    (error) => error.code === "DEVICE_NOT_FOUND",
  );
});

test("chấp nhận trạng thái điều khiển hợp lệ", () => {
  assert.deepEqual(validateStatePatch({ fan: "ON" }), { fan: "ON" });
  assert.deepEqual(validateStatePatch({ light: "OFF", fan: "ON" }), {
    light: "OFF",
    fan: "ON",
  });
});

test("từ chối trạng thái điều khiển không hợp lệ", () => {
  assert.throws(
    () => validateStatePatch({ fan: "RUNNING" }),
    (error) => error.code === "INVALID_STATE_VALUE",
  );

  assert.throws(
    () => validateStatePatch({ door: "ON" }),
    (error) => error.code === "INVALID_ACTUATOR",
  );
});

test("từ chối desired state rỗng", () => {
  assert.throws(
    () => validateStatePatch({}),
    (error) => error.code === "EMPTY_STATE",
  );
});

test("từ chối desired state không phải object", () => {
  assert.throws(
    () => validateStatePatch(null),
    (error) => error.code === "INVALID_STATE",
  );

  assert.throws(
    () => validateStatePatch(["ON"]),
    (error) => error.code === "INVALID_STATE",
  );
});

test("tạo MQTT command topic hợp lệ", () => {
  assert.equal(
    buildDeviceCommandTopic("ROOM_302", "CTRL_01"),
    "smartclassroom/room/ROOM_302/device/CTRL_01/command",
  );
});

test("từ chối MQTT topic chứa ký tự không hợp lệ", () => {
  assert.throws(
    () => buildDeviceCommandTopic("ROOM/302", "CTRL_01"),
    (error) => error.code === "INVALID_TOPIC",
  );
});
