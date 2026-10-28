import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().url().refine((v) => /^postgres(ql)?:\/\//.test(v)).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.coerce.number().int().min(60).max(86400).default(3600),
  MQTT_URL: z.string().url().refine((v) => /^mqtts?:\/\//.test(v)).optional(),
  MQTT_USERNAME: z.string().min(1).max(40).default("backend_service"),
  MQTT_PASSWORD: z.string().min(16).optional(),
  MQTT_CLIENT_ID: z.string().min(1).max(64).default("backend-01"),
  MQTT_ADMIN_USERNAME: z.string().min(1).max(40).default("admin"),
  MQTT_ADMIN_PASSWORD: z.string().min(16).optional(),
  DEVICE_SECRET_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  TELEMETRY_FRESHNESS_S: z.coerce.number().int().min(1).max(300).default(30),
  HEARTBEAT_TIMEOUT_S: z.coerce.number().int().min(5).max(300).default(30),
  COMMAND_TIMEOUT_S: z.coerce.number().int().min(3).max(10).default(5),
  MANUAL_OVERRIDE_S: z.coerce.number().int().min(0).max(86400).default(300),
});

export function loadConfig(env = process.env, { requireDatabase = false, requireAuth = false, requireBroker = false } = {}) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Only field names are reported; never echo an environment value.
    throw new Error(`Cấu hình không hợp lệ: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const data = result.data;
  if (requireDatabase && !data.DATABASE_URL) throw new Error("Cấu hình không hợp lệ: DATABASE_URL");
  if (requireAuth && !data.JWT_SECRET) throw new Error("Cấu hình không hợp lệ: JWT_SECRET");
  if (requireBroker && ["MQTT_URL", "MQTT_PASSWORD", "MQTT_ADMIN_PASSWORD", "DEVICE_SECRET_KEY"].some((key) => !data[key])) throw new Error("Cấu hình không hợp lệ: MQTT/DEVICE_SECRET_KEY");
  if (data.MQTT_USERNAME === data.MQTT_ADMIN_USERNAME) throw new Error("Tài khoản backend và quản trị MQTT phải tách biệt");
  const corsOrigins = data.CORS_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean);
  if (corsOrigins.some((v) => { try { return new URL(v).origin !== v; } catch { return true; } })) {
    throw new Error("Cấu hình không hợp lệ: CORS_ORIGINS");
  }
  return Object.freeze({ env: data.NODE_ENV, host: data.HOST, port: data.PORT, corsOrigins, databaseUrl: data.DATABASE_URL, jwtSecret: data.JWT_SECRET, jwtExpiresIn: data.JWT_EXPIRES_IN,
    mqttUrl: data.MQTT_URL, mqttUsername: data.MQTT_USERNAME, mqttPassword: data.MQTT_PASSWORD, mqttClientId: data.MQTT_CLIENT_ID,
    mqttAdminUsername: data.MQTT_ADMIN_USERNAME, mqttAdminPassword: data.MQTT_ADMIN_PASSWORD, deviceSecretKey: data.DEVICE_SECRET_KEY,
    telemetryFreshnessSeconds: data.TELEMETRY_FRESHNESS_S, heartbeatTimeoutSeconds: data.HEARTBEAT_TIMEOUT_S,
    commandTimeoutSeconds: data.COMMAND_TIMEOUT_S, manualOverrideSeconds: data.MANUAL_OVERRIDE_S });
}
