import test from "node:test";
import assert from "node:assert/strict";
import { iotFixture } from "../helpers/iot.js";

async function uploadFirmware(
  f,
  {
    version = "1.0.1",
    deviceType = "SENSOR_NODE",
    hardwareTarget = "ESP32",
    content = Buffer.from("firmware-test-content"),
  } = {},
) {
  const response = await fetch(`${f.base}/api/v1/ota/firmware`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.token}`,
      "Content-Type": "application/octet-stream",
      "x-firmware-version": version,
      "x-device-type": deviceType,
      "x-hardware-target": hardwareTarget,
      "x-firmware-file-name": "firmware.bin",
    },
    body: content,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test("OTA: đăng ký firmware hợp lệ", async (t) => {
  const f = await iotFixture(t);
  const response = await uploadFirmware(f);

  assert.equal(response.status, 201);
  assert.equal(response.body.data.status, "DRAFT");
  assert.equal(response.body.data.version, "1.0.1");
  assert.ok(response.body.data.firmware_id);
  assert.ok(response.body.data.sha256);
  assert.equal(response.body.data.file_size, 21);
});

test("OTA: từ chối file firmware rỗng", async (t) => {
  const f = await iotFixture(t);
  const response = await uploadFirmware(f, { content: Buffer.alloc(0) });

  assert.notEqual(response.status, 201);
});

test("OTA: từ chối firmware thiếu metadata", async (t) => {
  const f = await iotFixture(t);

  const response = await fetch(`${f.base}/api/v1/ota/firmware`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${f.token}`,
      "Content-Type": "application/octet-stream",
      "x-firmware-version": "1.0.1",
    },
    body: Buffer.from("firmware"),
  });

  assert.equal(response.status, 400);
});

test("OTA: phát hành firmware và tạo chữ ký", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);

  assert.equal(uploaded.status, 201);

  const response = await f.request(
    `/ota/firmware/${uploaded.body.data.firmware_id}/publish`,
    { method: "POST", token: f.token },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "PUBLISHED");
  assert.ok(response.body.data.signature);
});

test("OTA: không phát hành lại firmware đã phát hành", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);
  const id = uploaded.body.data.firmware_id;

  const first = await f.request(`/ota/firmware/${id}/publish`, {
    method: "POST",
    token: f.token,
  });

  const second = await f.request(`/ota/firmware/${id}/publish`, {
    method: "POST",
    token: f.token,
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
});

test("OTA: thu hồi firmware đã phát hành", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);
  const id = uploaded.body.data.firmware_id;

  const published = await f.request(`/ota/firmware/${id}/publish`, {
    method: "POST",
    token: f.token,
  });

  assert.equal(published.status, 200);

  const revoked = await f.request(`/ota/firmware/${id}/revoke`, {
    method: "POST",
    token: f.token,
  });

  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.status, "REVOKED");
});

test("OTA: không thu hồi firmware chưa phát hành", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);

  const response = await f.request(
    `/ota/firmware/${uploaded.body.data.firmware_id}/revoke`,
    { method: "POST", token: f.token },
  );

  assert.equal(response.status, 409);
});

test("OTA: danh sách firmware chỉ trả dữ liệu phù hợp quyền", async (t) => {
  const f = await iotFixture(t);
  await uploadFirmware(f);

  const response = await f.request("/ota/firmware", {
    token: f.token,
  });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data));
});

test("OTA: từ chối truy cập API quản lý khi không có token", async (t) => {
  const f = await iotFixture(t);

  const response = await f.request("/ota/firmware");

  assert.ok([401, 403].includes(response.status));
});

test("OTA: URL tải firmware có chữ ký hợp lệ", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);
  const id = uploaded.body.data.firmware_id;

  await f.request(`/ota/firmware/${id}/publish`, {
    method: "POST",
    token: f.token,
  });

  const expiresAt = new Date(Date.now() + 60000);
  const url = await f.downloadSigner.create(
    id,
    uploaded.body.data.firmware_id + ".bin",
    expiresAt,
  );

  const parsed = new URL(url);
  const [, token, signature] = parsed.pathname.split("/").slice(-3);

  assert.ok(token);
  assert.ok(signature);
  assert.doesNotThrow(() => f.downloadSigner.verify(token, signature));
});

test("OTA: từ chối URL tải firmware sai chữ ký", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);

  const token = Buffer.from(
    JSON.stringify({
      firmware_id: uploaded.body.data.firmware_id,
      storage_path: "invalid.bin",
      expires_at: Date.now() + 60000,
    }),
  ).toString("base64url");

  assert.throws(() => f.downloadSigner.verify(token, "invalid-signature"), {
    code: "OTA_DOWNLOAD_TOKEN_INVALID",
  });
});

test("OTA: từ chối URL tải firmware hết hạn", async (t) => {
  const f = await iotFixture(t);
  const uploaded = await uploadFirmware(f);

  const url = await f.downloadSigner.create(
    uploaded.body.data.firmware_id,
    uploaded.body.data.firmware_id + ".bin",
    new Date(Date.now() - 1000),
  );

  const parsed = new URL(url);
  const parts = parsed.pathname.split("/");
  const token = parts.at(-2);
  const signature = parts.at(-1);

  assert.throws(() => f.downloadSigner.verify(token, signature), {
    code: "OTA_DOWNLOAD_TOKEN_INVALID",
  });
});
