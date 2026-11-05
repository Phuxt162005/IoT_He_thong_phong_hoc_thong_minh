import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture, waitFor } from "../helpers/iot.js";

test("OTA firmware upload, signing, MQTT delivery and device status complete an update", async (t) => {
  const f = await iotFixture(t);
  const node = await f.activateSensor();
  const hardware = (await f.pool.query(
    "SELECT hardware_version FROM devices WHERE device_id=$1",
    [node.device.device_id],
  )).rows[0].hardware_version;
  assert.ok(hardware, "test device must have a hardware target");

  const artifact = Buffer.from("test-firmware-image-v1");
  const upload = await f.requestRaw("/ota/firmware", {
    token: f.token,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Firmware-Version": "test-2",
      "X-Device-Type": "SENSOR_NODE",
      "X-Hardware-Target": hardware,
      "X-Firmware-File-Name": "sensor-test.bin",
      "X-Release-Notes": "OTA integration test",
    },
    body: artifact,
  });
  assert.equal(upload.status, 201);
  const firmware = upload.body.data;
  assert.equal(firmware.status, "DRAFT");
  assert.equal(firmware.file_size, artifact.length);

  const published = await f.request(`/ota/firmware/${firmware.firmware_id}/publish`, {
    method: "POST",
    token: f.token,
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.data.status, "PUBLISHED");
  assert.ok(published.body.data.signature);

  const received = [];
  node.client.on("message", (topic, raw) => {
    if (topic === `${node.topic}/ota/command`) received.push(JSON.parse(raw.toString()));
  });
  await node.client.subscribeAsync(`${node.topic}/ota/command`, { qos: 1 });

  const requested = await f.request(`/devices/${node.device.device_id}/ota`, {
    method: "POST",
    token: f.token,
    body: { firmware_id: firmware.firmware_id },
  });
  assert.equal(requested.status, 202);
  const job = requested.body.data;
  await waitFor(() => received.length === 1);
  const command = received[0];
  assert.equal(command.job_id, job.job_id);
  assert.equal(command.device_id, node.device.device_code);
  assert.equal(command.room_id, f.room.room_code);
  assert.equal(command.session_id, "boot-1");
  assert.equal(command.version, "test-2");
  assert.equal(command.sha256, firmware.sha256);
  assert.equal(command.signature, published.body.data.signature);
  const download = new URL(command.download_url);
  const parts = download.pathname.split("/");
  const token = parts.at(-2);
  const signature = parts.at(-1);
  assert.equal(f.downloadSigner.verify(token, signature).firmware_id, firmware.firmware_id);

  const report = async (status, progress, extra = {}) => {
    await node.client.publishAsync(`${node.topic}/ota/status`, JSON.stringify({
      job_id: job.job_id,
      device_id: node.device.device_code,
      room_id: f.room.room_code,
      session_id: "boot-1",
      status,
      progress,
      timestamp: Date.now(),
      ...extra,
    }), { qos: 1 });
    await waitFor(async () => (await f.pool.query(
      "SELECT status FROM ota_jobs WHERE job_id=$1",
      [job.job_id],
    )).rows[0].status === status);
  };

  await report("DOWNLOADING", 5);
  await report("VERIFYING", 35);
  await report("INSTALLING", 70);
  await report("REBOOTING", 95);
  await report("SUCCESS", 100, { version: "test-2" });

  const completed = (await f.pool.query(
    "SELECT status,progress,finished_at FROM ota_jobs WHERE job_id=$1",
    [job.job_id],
  )).rows[0];
  assert.equal(completed.status, "SUCCESS");
  assert.equal(completed.progress, 100);
  assert.ok(completed.finished_at);
  const updatedDevice = (await f.pool.query(
    "SELECT firmware_version FROM devices WHERE device_id=$1",
    [node.device.device_id],
  )).rows[0];
  assert.equal(updatedDevice.firmware_version, "test-2");
  assert.equal((await f.pool.query(
    "SELECT status FROM ota_command_outbox WHERE job_id=$1",
    [job.job_id],
  )).rows[0].status, "SENT");
});
