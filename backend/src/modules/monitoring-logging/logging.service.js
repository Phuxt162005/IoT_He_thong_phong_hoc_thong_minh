const LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);
const SECRET_KEY = /password|passwd|token|secret|authorization|api.?key/i;

function sanitize(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return value.length > 2000
      ? `${value.slice(0, 2000)}...[TRUNCATED]`
      : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitize(item, "", depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      result[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    return result;
  }
  return String(value);
}

export class LoggingService {
  constructor({
    sink,
    now = () => new Date().toISOString(),
    serviceName = "smart-classroom-backend",
  }) {
    if (!sink || typeof sink.write !== "function")
      throw new TypeError("sink phải cung cấp write()");
    this.sink = sink;
    this.now = now;
    this.serviceName = serviceName;
  }

  log(level, message, metadata = {}) {
    if (!LEVELS.has(level))
      throw new TypeError(`Log level không hợp lệ: ${level}`);
    if (typeof message !== "string" || !message.trim())
      throw new TypeError("message không được rỗng");

    const entry = {
      timestamp: this.now(),
      level,
      service: this.serviceName,
      message: message.slice(0, 2000),
      metadata: sanitize(metadata),
    };

    this.sink.write(entry);
    return entry;
  }

  debug(message, metadata) {
    return this.log("DEBUG", message, metadata);
  }
  info(message, metadata) {
    return this.log("INFO", message, metadata);
  }
  warn(message, metadata) {
    return this.log("WARN", message, metadata);
  }
  error(message, metadata) {
    return this.log("ERROR", message, metadata);
  }
}
