import { resolve, relative, isAbsolute } from "node:path";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { compose, docker } from "./docker-process.mjs";
const database = `smartclass_restore_${randomBytes(8).toString("hex")}`;
let created = false;
try {
  const path = resolve(process.argv[2] ?? ""); const root = resolve("deployment/backups");
  const local = relative(root, path);
  if (!process.argv[2] || local.startsWith("..") || isAbsolute(local) || !path.endsWith(".dump") || !(await stat(path)).isFile()) throw new Error("INVALID_BACKUP_PATH");
  const manifest = JSON.parse(await readFile(`${path}.json`, "utf8"));
  const hash = createHash("sha256"); for await (const raw of createReadStream(path)) hash.update(raw);
  if (hash.digest("hex") !== manifest.sha256 || (await stat(path)).size !== manifest.bytes) throw new Error("BACKUP_CHECKSUM_MISMATCH");
  await docker([...compose, "exec", "-T", "db", "createdb", "-U", "smartclass_owner", database]); created = true;
  await docker([...compose, "exec", "-T", "db", "pg_restore", "-U", "smartclass_owner", "-d", database, "--no-owner", "--exit-on-error"], { input: createReadStream(path) });
  const result = await docker([...compose, "exec", "-T", "db", "psql", "-U", "smartclass_owner", "-d", database, "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT json_build_object('users',(SELECT count(*) FROM users),'rooms',(SELECT count(*) FROM rooms),'devices',(SELECT count(*) FROM devices),'telemetry',(SELECT count(*) FROM sensor_data),'audit',(SELECT count(*) FROM audit_logs),'schema',(SELECT version FROM backend_schema_state));"]);
  await docker([...compose, "exec", "-T", "db", "psql", "-U", "smartclass_owner", "-d", database, "-At", "-v", "ON_ERROR_STOP=1", "-c", "SET ROLE smartclass_app; SELECT count(*) FROM audit_logs;"]);
  let immutable = false;
  try { await docker([...compose, "exec", "-T", "db", "psql", "-U", "smartclass_owner", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "UPDATE audit_logs SET action=action;"]); }
  catch { immutable = true; }
  if (!immutable) throw new Error("AUDIT_GUARD_MISSING");
  console.log(JSON.stringify({ restored: true, isolated_database: database, counts: JSON.parse(result) }));
} catch { console.error(JSON.stringify({ error: "RESTORE_CHECK_FAILED" })); process.exitCode = 1; }
finally {
  if (created && /^smartclass_restore_[a-f0-9]{16}$/.test(database)) {
    try { await docker([...compose, "exec", "-T", "db", "dropdb", "-U", "smartclass_owner", database]); }
    catch { console.error(JSON.stringify({ error: "RESTORE_CHECK_CLEANUP_FAILED", database })); process.exitCode = 1; }
  }
}
