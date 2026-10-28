import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryDeviceShadowRepository } from "../backend/src/modules/device-shadow/device-shadow.repository.memory.js";
import { DeviceShadowService } from "../backend/src/modules/device-shadow/device-shadow.service.js";
import { buildDeviceCommandTopic } from "../backend/src/modules/device-shadow/device-shadow.mqtt.js";

function createFixture({ failPublish = false } = {}) {
  const repository = new InMemoryDeviceShadowRepository();
  const published = [];
  const mqttPublisher = {
    async publishCommand(topic, payload) {
      if (failPublish) throw new Error("Broker unavailable");
      published.push({ topic, payload });
    },
  };
  const service = new DeviceShadowService({
    repository,
    mqttPublisher,
    now: () => "2026-10-28T10:00:00.000Z",
  });
  return { repository, published, service };
}

test("tạo Device Shadow với trạng thái ban đầu", async () => {
  const { repository, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });
  const shadow = await service.getShadow("CTRL_01");
  assert.equal(shadow.desiredState.fan, "OFF");
  assert.equal(shadow.reportedState.fan, "OFF");
  assert.equal(shadow.inSync, true);
});

test("gửi lệnh bật quạt và lưu desired state", async () => {
  const { repository, published, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });
  const result = await service.setDesiredState(
    "CTRL_01",
    { fan: "ON" },
    { requestedBy: "user-01" },
  );

  assert.equal(result.command.status, "SENT");
  assert.equal(result.shadow.desiredState.fan, "ON");
  assert.equal(result.shadow.reportedState.fan, "OFF");
  assert.equal(result.shadow.inSync, false);
  assert.equal(published.length, 1);
  assert.equal(
    published[0].topic,
    "smartclassroom/room/ROOM_302/device/CTRL_01/command",
  );
  assert.equal(published[0].payload.desiredState.fan, "ON");
  assert.equal(published[0].payload.commandId, result.command.commandId);
});

test("reported state và ACK thành công đưa shadow về đồng bộ", async () => {
  const { repository, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });
  const { command } = await service.setDesiredState("CTRL_01", { fan: "ON" });

  const result = await service.handleCommandAck({
    deviceId: "CTRL_01",
    commandId: command.commandId,
    status: "SUCCESS",
    reportedState: { fan: "ON" },
  });

  assert.equal(result.command.status, "ACKNOWLEDGED");
  assert.equal(result.shadow.reportedState.fan, "ON");
  assert.equal(result.shadow.inSync, true);
});

test("không tự coi desired state là reported state khi publish thành công", async () => {
  const { repository, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });
  await service.setDesiredState("CTRL_01", { light: "ON" });
  const shadow = await service.getShadow("CTRL_01");

  assert.equal(shadow.desiredState.light, "ON");
  assert.equal(shadow.reportedState.light, "OFF");
  assert.equal(shadow.inSync, false);
});

test("ghi nhận lỗi nếu gửi lệnh MQTT thất bại", async () => {
  const { repository, service } = createFixture({ failPublish: true });
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  await assert.rejects(
    () => service.setDesiredState("CTRL_01", { fan: "ON" }),
    (error) => error.code === "MQTT_PUBLISH_FAILED",
  );

  const shadow = await service.getShadow("CTRL_01");
  const command = await repository.getLatestCommandForDevice("CTRL_01");
  assert.equal(shadow.desiredState.fan, "ON");
  assert.equal(command.status, "PUBLISH_FAILED");
  assert.notEqual(shadow.reportedState.fan, "ON");
});

test("từ chối trạng thái không hợp lệ", async () => {
  const { repository, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });

  await assert.rejects(
    () => service.setDesiredState("CTRL_01", { fan: "RUNNING" }),
    (error) => error.code === "INVALID_STATE_VALUE",
  );
});

test("từ chối ACK của thiết bị không khớp lệnh", async () => {
  const { repository, service } = createFixture();
  await repository.registerDevice({
    deviceId: "CTRL_01",
    roomCode: "ROOM_302",
  });
  const { command } = await service.setDesiredState("CTRL_01", { fan: "ON" });

  await assert.rejects(
    () =>
      service.handleCommandAck({
        deviceId: "CTRL_02",
        commandId: command.commandId,
        status: "SUCCESS",
      }),
    (error) => error.code === "ACK_COMMAND_MISMATCH",
  );
});

test("từ chối topic chứa ký tự không hợp lệ", () => {
  assert.throws(
    () => buildDeviceCommandTopic("ROOM/302", "CTRL_01"),
    (error) => error.code === "INVALID_TOPIC",
  );
});
