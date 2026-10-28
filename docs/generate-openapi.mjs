import { writeFile } from "node:fs/promises";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (maxLength = 255) => ({ type: "string", minLength: 1, maxLength });
const enumeration = (...values) => ({ type: "string", enum: values });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", pattern: "^[1-9][0-9]{0,18}$", description: "PostgreSQL BIGINT ID, serialized as a string." };
const lifecycle = enumeration("REGISTERED", "PROVISIONED", "ACTIVE", "FAULT", "MAINTENANCE", "REVOKED", "DECOMMISSIONED");
const role = enumeration("ADMIN", "OPERATOR", "VIEWER");
const reason = { reason: { ...str(255), minLength: 3 }, confirmed: { type: "boolean" } };
const user = { username: { type: "string", pattern: "^[A-Za-z0-9_.-]{3,64}$" }, password: { ...str(128), minLength: 12, writeOnly: true }, display_name: str(100), role };
const room = { room_code: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" }, room_name: str(100) };
const device = { device_code: room.room_code, device_name: str(100), device_type: enumeration("SENSOR_NODE", "CONTROL_NODE"), room_id: id, hardware_version: str(64), firmware_version: str(64) };
const threshold = { sensor_type: enumeration("TEMPERATURE", "HUMIDITY"), severity: enumeration("WARNING", "CRITICAL"), operator: enumeration("GT", "GTE"), threshold_value: { type: "number" }, clear_value: { type: "number" }, is_enabled: { type: "boolean" } };
const rule = { name: str(100), target_device_id: id, actuator: enumeration("LIGHT", "FAN"), action: enumeration("ON", "OFF"), condition: ref("Condition"), hold_seconds: integer(0, 300), cooldown_seconds: integer(1, 3600), priority: integer(1, 1000), is_enabled: { type: "boolean" } };
const schemas = {
  Id: id,
  Error: object({ success: { const: false }, error: object({ code: str(64), message: str(), details: {} }, ["code", "message"]), request_id: str(64) }),
  Result: { type: "object", required: ["success", "data"], properties: { success: { const: true }, data: {}, meta: { type: "object", description: "Lists: page, page_size, total; time queries also return from/to." } } },
  Login: object({ username: str(64), password: { ...str(128), writeOnly: true } }),
  PasswordChange: object({ current_password: { ...str(128), writeOnly: true }, new_password: { ...str(128), minLength: 12, writeOnly: true } }),
  UserCreate: object(user), UserPatch: { ...object({ display_name: user.display_name, role, status: enumeration("ACTIVE", "DISABLED") }, []), minProperties: 1 },
  RoomCreate: object(room), RoomPatch: { ...object({ room_name: room.room_name, status: enumeration("ACTIVE", "INACTIVE") }, []), minProperties: 1 },
  RoomMembers: object({ user_ids: { type: "array", items: id, maxItems: 500, uniqueItems: true } }),
  DeviceCreate: object(device, ["device_code", "device_name", "device_type"]),
  DevicePatch: { ...object({ device_name: device.device_name, room_id: { anyOf: [id, { type: "null" }] }, hardware_version: str(64), firmware_version: str(64) }, []), minProperties: 1 },
  Action: object(reason, ["reason"]),
  DesiredState: { ...object({ light: enumeration("ON", "OFF"), fan: enumeration("ON", "OFF") }, []), minProperties: 1 },
  CommandCreate: object({ desired_state: ref("DesiredState"), timeout_seconds: integer(3, 10) }, ["desired_state"]),
  ConfigCreate: object({ settings: { ...object({ sample_interval_seconds: integer(1, 300), heartbeat_interval_seconds: integer(1, 60) }, []), minProperties: 1, description: "Sample interval is Sensor-only. Heartbeat interval must be <= HEARTBEAT_TIMEOUT_S / 3." } }),
  AlertResolve: object({ reason: reason.reason }),
  Thresholds: object({ thresholds: { type: "array", minItems: 1, maxItems: 4, items: object(threshold), description: "Unique sensor/severity pairs; critical >= warning and clear <= threshold. Temperature -10..60°C; humidity 0..100%." } }),
  Condition: { description: "Bounded interpreter: at most 20 nodes and depth 4; all/any arrays contain 1..10 children. No code evaluation.", oneOf: [
    object({ all: { type: "array", minItems: 1, maxItems: 10, items: ref("Condition") } }),
    object({ any: { type: "array", minItems: 1, maxItems: 10, items: ref("Condition") } }),
    object({ metric: enumeration("temperature", "humidity", "lux"), operator: enumeration("GT", "GTE", "LT", "LTE", "EQ", "NE"), value: { type: "number" } }),
    object({ metric: { const: "occupancy" }, operator: enumeration("EQ", "NE"), value: { type: "boolean" } }),
  ] },
  RuleCreate: object(rule), RulePatch: { ...object(rule, []), minProperties: 1 },
  ControlMode: object({ control_mode: enumeration("AUTO", "MANUAL"), reason: reason.reason }),
};
const paths = {};
const query = (name, schema, description) => ({ in: "query", name, schema, ...(description ? { description } : {}) });
const pages = [query("page", { ...integer(1, 1000000), default: 1 }), query("page_size", { ...integer(1, 100), default: 20 })];
const times = [query("from", { type: "string", format: "date-time" }, "Inclusive, ISO with timezone."), query("to", { type: "string", format: "date-time" }, "Exclusive, ISO with timezone.")];
function add(path, method, summary, { body, params = [], status = "200", public: unauthenticated = false, description = "", csv = false } = {}) {
  const parameters = [...(path.includes("{id}") ? [{ in: "path", name: "id", required: true, schema: id }] : []), ...params];
  const response = { description: csv ? "CSV attachment, up to 5000 rows." : "Successful result; IDs are strings and timestamps UTC ISO 8601.", content: csv ? { "text/csv": { schema: { type: "string" } } } : { "application/json": { schema: ref("Result") } } };
  const operation = { summary, description, operationId: `${method}_${path.replaceAll(/[^a-zA-Z0-9]/g, "_")}`, tags: [path.split("/")[3] ?? "Health"], parameters,
    responses: { [status]: response, default: { description: "400 validation; 401 session; 403 role; 404 missing/out of scope; 409 conflict; 413 payload/export limit; 429 rate limit; 503 dependency. No SQL, stack or credentials returned.", content: { "application/json": { schema: ref("Error") } } } },
    ...(unauthenticated ? { security: [] } : {}), ...(body ? { requestBody: { required: true, content: { "application/json": { schema: ref(body) } } } } : {}) };
  if (status !== "200" && method === "post" && (path.endsWith("commands") || /provision|rotate-credentials|revoke/.test(path))) operation.responses["200"] = response;
  paths[path] ??= {}; paths[path][method] = operation;
}
const api = (path, method, summary, options) => add(`/api/v1${path}`, method, summary, options);
add("/health", "get", "Process liveness", { public: true }); add("/ready", "get", "Expected schema, database, MQTT subscriptions and realtime listener readiness", { public: true });
api("/auth/login", "post", "Login; 5 failed attempts per username/IP in 15 minutes", { body: "Login", public: true });
api("/auth/me", "get", "Current user"); api("/auth/logout", "post", "Invalidate all user tokens"); api("/auth/change-password", "post", "Change password and invalidate all tokens", { body: "PasswordChange" });
api("/users", "get", "Admin lists users", { params: [...pages, query("role", role), query("status", enumeration("ACTIVE", "DISABLED"))] });
api("/users", "post", "Admin creates user", { body: "UserCreate", status: "201" });
api("/users/{id}", "get", "Admin reads user"); api("/users/{id}", "patch", "Admin changes user, preserving the last active Admin", { body: "UserPatch" });
api("/rooms", "get", "Scoped rooms", { params: [...pages, query("status", enumeration("ACTIVE", "INACTIVE"))] });
api("/rooms", "post", "Admin creates room", { body: "RoomCreate", status: "201" });
api("/rooms/{id}", "get", "Scoped room detail"); api("/rooms/{id}", "patch", "Admin updates room", { body: "RoomPatch" });
api("/rooms/{id}/users", "get", "Admin reads room membership");
api("/rooms/{id}/users", "put", "Admin replaces membership; changed scope invalidates tokens", { body: "RoomMembers" });
api("/devices", "get", "Scoped device list", { params: [...pages, query("room_id", id), query("device_type", device.device_type), query("lifecycle_status", lifecycle), query("connection_status", enumeration("UNKNOWN", "ONLINE", "OFFLINE"))] });
api("/devices", "post", "Admin registers device", { body: "DeviceCreate", status: "201" });
api("/devices/{id}", "get", "Scoped device detail"); api("/devices/{id}", "patch", "Admin updates metadata; reassignment only while REGISTERED", { body: "DevicePatch" });
for (const action of ["maintenance", "resume", "clear-fault", "recover", "decommission", "provision", "rotate-credentials", "revoke", "activate"]) api(`/devices/{id}/${action}`, "post", `Admin ${action}`, { body: "Action", status: ["provision", "rotate-credentials", "revoke"].includes(action) ? "202" : "200", description: "Revoke/decommission require confirmed:true; re-provisioning a revoked device also requires confirmation. Provision/rotate returns the secret once; 202 means broker synchronization is pending." });
api("/devices/{id}/broker-status", "get", "Scoped broker synchronization status; no secret");
api("/devices/{id}/lifecycle-events", "get", "Scoped immutable lifecycle history", { params: [...pages, ...times, query("from_status", lifecycle), query("to_status", lifecycle), query("actor_type", enumeration("USER", "DEVICE", "SYSTEM")), query("actor_id", id)] });
api("/devices/{id}/commands", "get", "Scoped command history", { params: pages });
api("/devices/{id}/commands", "post", "Admin/Operator creates manual command", { body: "CommandCreate", status: "202", params: [{ in: "header", name: "Idempotency-Key", schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, description: "60-second cache per user/device. Same key with different content gives 409; cached response 200." }] });
api("/devices/{id}/shadow", "get", "Scoped desired/reported state and differences");
api("/devices/{id}/configs", "get", "Scoped desired/applied configuration and history", { params: pages }); api("/devices/{id}/configs", "post", "Admin requests versioned configuration", { body: "ConfigCreate", status: "202" });
api("/alerts", "get", "Scoped alert history", { params: [...pages, query("room_id", id), query("status", enumeration("OPEN", "ACKNOWLEDGED", "RESOLVED")), query("severity", threshold.severity), query("alert_type", enumeration("TEMP_HIGH", "HUMIDITY_HIGH", "DEVICE_OFFLINE", "DEVICE_FAULT"))] });
api("/alerts/{id}", "get", "Scoped alert detail"); api("/alerts/{id}/acknowledge", "post", "Admin/Operator acknowledges alert"); api("/alerts/{id}/resolve", "post", "Admin/Operator resolves alert", { body: "AlertResolve" });
api("/rooms/{id}/alert-thresholds", "get", "Scoped effective thresholds"); api("/rooms/{id}/alert-thresholds", "put", "Admin overrides room thresholds", { body: "Thresholds" });
api("/rooms/{id}/automation-rules", "get", "Scoped automation rules", { params: pages }); api("/rooms/{id}/automation-rules", "post", "Admin creates rule; lower priority number wins", { body: "RuleCreate", status: "201" }); api("/automation-rules/{id}", "patch", "Admin updates/disables rule", { body: "RulePatch" });
api("/devices/{id}/control-mode", "put", "Admin/Operator changes AUTO/MANUAL mode", { body: "ControlMode" });
api("/dashboard", "get", "Scoped dashboard", { params: [query("room_id", id)] });
for (const kind of ["rooms", "devices"]) api(`/${kind}/{id}/telemetry`, "get", "Scoped measured-time history; default 24h, maximum 31 days", { params: [...pages, ...times, query("device_id", id)] });
api("/rooms/{id}/telemetry/latest", "get", "Scoped latest sample per Sensor, with stale flag", { params: pages });
api("/rooms/{id}/telemetry/stats", "get", "UTC hourly/daily statistics, excluding clock-skew; maximum 31 days", { params: [...times, query("bucket", { ...enumeration("hour", "day"), default: "hour" })] });
api("/rooms/{id}/telemetry/export", "get", "Scoped CSV, maximum 5000 samples and 31 days", { params: [...times, query("device_id", id)], csv: true });
api("/audit-logs", "get", "Admin searches append-only audit; default 7 days, maximum 90 days", { params: [...pages, ...times, query("actor_type", enumeration("USER", "DEVICE", "SYSTEM")), query("actor_id", id), query("action", str(64)), query("target_type", str(32)), query("target_id", str(64)), query("result", enumeration("SUCCESS", "FAILURE", "DENIED")), query("request_id", str(64))] });
const document = { openapi: "3.1.1", info: { title: "Smart Classroom Backend", version: "1.0.0-backend", description: "Backend HTTP contract. Authenticated requests are limited to 100/minute/user. Roles and room membership are checked server-side. For MQTT and WebSocket first-frame authentication see backend-contracts.md and README.md. Hardware acceptance is pending." }, servers: [{ url: "http://localhost:3000", description: "Local Docker/Node; production uses HTTPS." }], security: [{ bearerAuth: [] }], paths, components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, schemas } };
await writeFile(new URL("./openapi.json", import.meta.url), JSON.stringify(document, null, 2) + "\n");
console.log(`OpenAPI: ${Object.values(paths).reduce((count, methods) => count + Object.keys(methods).length, 0)} operations`);
