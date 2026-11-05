import { randomBytes, generateKeyPairSync } from "node:crypto";
import { writeFile, access } from "node:fs/promises";

const files = [".env", ".env.test", "ota-ed25519-public.pem"];

for (const file of files) {
  try {
    await access(file);
    throw new Error(
      `${file} đã tồn tại; không ghi đè cấu hình hoặc khóa hiện có`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const owner = randomBytes(24).toString("hex");
const app = randomBytes(24).toString("hex");
const admin = randomBytes(24).toString("hex");
const mqttAdmin = randomBytes(24).toString("hex");
const mqttBackend = randomBytes(24).toString("hex");
const testMqttAdmin = randomBytes(24).toString("hex");
const testMqttBackend = randomBytes(24).toString("hex");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const privateKeyB64 = privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64");

const publicKeyPem = publicKey.export({
  type: "spki",
  format: "pem",
});

const downloadSecret = randomBytes(32).toString("hex");
const jwtSecret = randomBytes(48).toString("hex");
const deviceSecret = randomBytes(32).toString("hex");

const common = `POSTGRES_PASSWORD=${owner}
POSTGRES_APP_PASSWORD=${app}
`;

const env = `NODE_ENV=development
HOST=127.0.0.1
PORT=3000
CORS_ORIGINS=http://localhost:5173
${common}DATABASE_URL=postgres://smartclass_app:${app}@127.0.0.1:5433/smartclass
MIGRATION_DATABASE_URL=postgres://smartclass_owner:${owner}@127.0.0.1:5433/smartclass
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${admin}
JWT_SECRET=${jwtSecret}
JWT_EXPIRES_IN=3600
MQTT_URL=mqtt://127.0.0.1:1884
MQTT_USERNAME=backend_service
MQTT_PASSWORD=${mqttBackend}
MQTT_CLIENT_ID=backend-01
MQTT_ADMIN_USERNAME=admin
MQTT_ADMIN_PASSWORD=${mqttAdmin}
TEST_MQTT_ADMIN_PASSWORD=${testMqttAdmin}
DEVICE_SECRET_KEY=${deviceSecret}
OTA_STORAGE_DIR=./storage/firmware
OTA_DOWNLOAD_BASE_URL=https://your-domain.example/api/v1
OTA_DOWNLOAD_SECRET=${downloadSecret}
OTA_MAX_FIRMWARE_BYTES=4194304
OTA_TIMEOUT_S=900
OTA_DOWNLOAD_URL_LIFETIME_S=300
OTA_SIGNING_PRIVATE_KEY_B64=${privateKeyB64}
`;

const envTest = `NODE_ENV=test
TEST_DATABASE_URL=postgres://smartclass_app:${app}@127.0.0.1:5434/smartclass_test
TEST_MIGRATION_DATABASE_URL=postgres://smartclass_owner:${owner}@127.0.0.1:5434/smartclass_test
TEST_MQTT_URL=mqtt://127.0.0.1:1885
TEST_MQTT_ADMIN_PASSWORD=${testMqttAdmin}
TEST_MQTT_PASSWORD=${testMqttBackend}
`;

await writeFile("ota-ed25519-public.pem", publicKeyPem, {
  flag: "wx",
  mode: 0o600,
});

try {
  await writeFile(".env", env, { flag: "wx", mode: 0o600 });
  await writeFile(".env.test", envTest, { flag: "wx", mode: 0o600 });
} catch (error) {
  // Không xóa hoặc ghi đè file người dùng nếu có xung đột.
  throw new Error(
    `Không hoàn tất khởi tạo môi trường: ${error.message}. Hãy kiểm tra các file đã được tạo trước khi chạy lại.`,
  );
}

console.log(
  "Đã tạo .env, .env.test và cặp khóa Ed25519. Không hiển thị secret.",
);
console.log(
  "Lưu ý: thay OTA_DOWNLOAD_BASE_URL bằng HTTPS URL có thể truy cập từ ESP32 trước khi thử OTA thực tế.",
);
