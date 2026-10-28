export async function writeAudit(client, { actorType = "SYSTEM", actorId = null, action, targetType, targetId = null, result = "SUCCESS", requestId = null, details = {} }) {
  // Callers supply a curated allowlist, never raw request bodies or credentials.
  await client.query(`INSERT INTO audit_logs(actor_type,actor_id,action,target_type,target_id,result,request_id,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actorType, actorId, action, targetType, targetId == null ? null : String(targetId), result, requestId, details]);
}
