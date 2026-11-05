import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { OtaDownloadSigner } from "../backend/src/modules/ota/ota.download-signer.js";
import { LocalFirmwareStorage } from "../backend/src/modules/ota/ota.storage.js";
import { OtaRepository } from "../backend/src/modules/ota/ota.repository.pg.js";
import { OtaService } from "../backend/src/modules/ota/ota.service.js";

const firmwareId = randomUUID();
const storagePath = `${firmwareId}.bin`;

test("OTA download signer creates verifiable expiring HTTPS URLs", () => {
  const signer = new OtaDownloadSigner({
    baseUrl: "https://iot.example.test/api/v1/",
    secret: "test-download-secret-that-is-long-enough",
  });
  const expiresAt = new Date(Date.now() + 60_000);
  const url = new URL(signer.sign(firmwareId, storagePath, expiresAt));
  assert.equal(url.origin, "https://iot.example.test");
  assert.match(url.pathname, /^\/api\/v1\/ota\/download\//);
  const pathParts = url.pathname.split("/");
  const token = pathParts.at(-2);
  const signature = pathParts.at(-1);
  const payload = signer.verify(token, signature);
  assert.equal(payload.firmware_id, firmwareId);
  assert.equal(payload.storage_path, storagePath);
  assert.equal(payload.expires_at, expiresAt.getTime());
});

test("OTA download signer rejects tampered, expired and non-HTTPS tokens", () => {
  const signer = new OtaDownloadSigner({
    baseUrl: "https://iot.example.test",
    secret: "test-download-secret-that-is-long-enough",
  });
  const token = Buffer.from(JSON.stringify({
    firmware_id: firmwareId,
    storage_path: storagePath,
    expires_at: Date.now() + 60_000,
  })).toString("base64url");
  assert.throws(() => signer.verify(token, "invalid"), (error) => error.code === "OTA_DOWNLOAD_TOKEN_INVALID");
  const expired = Buffer.from(JSON.stringify({
    firmware_id: firmwareId,
    storage_path: storagePath,
    expires_at: Date.now() - 1,
  })).toString("base64url");
  const signature = createHmac("sha256", "test-download-secret-that-is-long-enough").update(expired).digest("base64url");
  assert.throws(() => signer.verify(expired, signature), (error) => error.code === "OTA_DOWNLOAD_TOKEN_INVALID");
  assert.throws(() => new OtaDownloadSigner({ baseUrl: "http://iot.example.test", secret: "test-download-secret-that-is-long-enough" }), /HTTPS/);
});

test("local firmware storage writes, reads and removes only valid firmware paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ota-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new LocalFirmwareStorage({ directory });
  const buffer = Buffer.from("firmware-test-binary");
  const saved = await storage.save({ firmwareId, fileName: "firmware.bin", buffer });
  assert.equal(saved.storage_path, storagePath);
  assert.deepEqual(await storage.read(saved.storage_path), buffer);
  assert.equal((await storage.stat(saved.storage_path)).size, buffer.length);
  assert.deepEqual(await readFile(path.join(directory, storagePath)), buffer);
  await assert.rejects(() => storage.read("../outside.bin"), /đường dẫn firmware không hợp lệ/i);
  await storage.remove(saved.storage_path);
  await assert.rejects(() => storage.read(saved.storage_path), { code: "ENOENT" });
});

test("OTA repository enforces legal status transitions and monotonic progress", async () => {
  const repository = new OtaRepository({});
  let job = {
    job_id: randomUUID(),
    status: "NOTIFIED",
    progress: 0,
    timeout_at: new Date(Date.now() + 60_000),
  };
  repository.getJob = async () => ({ ...job });
  const client = {
    async query(sql, params) {
      assert.match(sql, /UPDATE ota_jobs/);
      job = { ...job, status: params[0], progress: params[1] ?? job.progress, error_code: params[2] };
      return { rows: [{ ...job }] };
    },
  };
  const downloading = await repository.updateJobStatus(client, job.job_id, { status: "DOWNLOADING", progress: 10 });
  assert.equal(downloading.status, "DOWNLOADING");
  assert.equal(downloading.progress, 10);
  await assert.rejects(
    () => repository.updateJobStatus(client, job.job_id, { status: "INSTALLING", progress: 20 }),
    (error) => error.code === "OTA_INVALID_TRANSITION",
  );
  await assert.rejects(
    () => repository.updateJobStatus(client, job.job_id, { status: "VERIFYING", progress: 9 }),
    (error) => error.code === "OTA_INVALID_PROGRESS",
  );
  job.status = "REBOOTING";
  await assert.rejects(
    () => repository.updateJobStatus(client, job.job_id, { status: "SUCCESS", progress: 99 }),
    (error) => error.code === "OTA_INVALID_SUCCESS",
  );
});

test("OTA service accepts only an Ed25519 private signing key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const encoded = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const dependencies = {
    pool: {},
    repository: {},
    mqtt: {},
    storage: {},
    downloadUrlSigner: {},
    firmwareSigningPrivateKeyB64: encoded,
  };
  assert.doesNotThrow(() => new OtaService(dependencies));
  assert.throws(
    () => new OtaService({ ...dependencies, firmwareSigningPrivateKeyB64: Buffer.from("not-a-key").toString("base64") }),
  );
});
