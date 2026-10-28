import "dotenv/config";
import { DynamicSecurity } from "./dynamic-security.js";
import { bootstrapBroker } from "./bootstrap.js";

try {
  const useTest = process.argv.includes("--test");
  if (useTest) (await import("dotenv")).default.config({ path: ".env.test", override: true, quiet: true });
  const prefix = useTest ? "TEST_" : "";
  const get = (name) => process.env[prefix + name];
  if (!["MQTT_URL", "MQTT_ADMIN_PASSWORD", "MQTT_PASSWORD"].every(get)) throw new Error("CONFIG_MISSING");
  const admin = new DynamicSecurity({ url: get("MQTT_URL"), username: get("MQTT_ADMIN_USERNAME") ?? "admin", password: get("MQTT_ADMIN_PASSWORD") });
  await bootstrapBroker(admin, { backendUsername: get("MQTT_USERNAME") ?? "backend_service", backendPassword: get("MQTT_PASSWORD"), backendClientId: get("MQTT_CLIENT_ID") ?? "backend-01" });
  console.log(JSON.stringify({ broker: useTest ? "test" : "application", initialized: true }));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? "BROKER_BOOTSTRAP_FAILED" })); process.exitCode = 1; }
