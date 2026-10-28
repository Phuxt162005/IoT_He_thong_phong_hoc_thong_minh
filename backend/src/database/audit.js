const sensitiveKey = /password|passwd|token|secret|authorization|api.?key|credential.*hash/i;
export function sanitizeAuditDetails(value, key = "", depth = 0) {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeAuditDetails(item, "", depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, item]) => [name, sanitizeAuditDetails(item, name, depth + 1)]));
  return String(value).slice(0, 2000);
}
export async function writeAudit(client, { actorType = "SYSTEM", actorId = null, action, targetType, targetId = null, result = "SUCCESS", requestId = null, details = {} }) {
  // Callers supply a curated allowlist, never raw request bodies or credentials.
  await client.query(`INSERT INTO audit_logs(actor_type,actor_id,action,target_type,target_id,result,request_id,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actorType, actorId, action, targetType, targetId == null ? null : String(targetId), result, requestId, sanitizeAuditDetails(details)]);
}
