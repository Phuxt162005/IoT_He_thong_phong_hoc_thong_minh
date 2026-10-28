import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().url().refine((v) => /^postgres(ql)?:\/\//.test(v)).optional(),
});

export function loadConfig(env = process.env, { requireDatabase = false } = {}) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Only field names are reported; never echo an environment value.
    throw new Error(`Cấu hình không hợp lệ: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const data = result.data;
  if (requireDatabase && !data.DATABASE_URL) throw new Error("Cấu hình không hợp lệ: DATABASE_URL");
  const corsOrigins = data.CORS_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean);
  if (corsOrigins.some((v) => { try { return new URL(v).origin !== v; } catch { return true; } })) {
    throw new Error("Cấu hình không hợp lệ: CORS_ORIGINS");
  }
  return Object.freeze({ env: data.NODE_ENV, host: data.HOST, port: data.PORT, corsOrigins, databaseUrl: data.DATABASE_URL });
}
