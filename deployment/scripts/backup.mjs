import { mkdir, stat, writeFile } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { compose, docker } from "./docker-process.mjs";
try {
  await mkdir("deployment/backups", { recursive: true });
  const name = `deployment/backups/smartclass-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.dump`;
  const stream = createWriteStream(name, { flags: "wx", mode: 0o600 });
  await docker([...compose, "exec", "-T", "db", "pg_dump", "-U", "smartclass_owner", "-d", "smartclass", "--format=custom", "--no-owner"], { output: stream });
  await finished(stream);
  const hash = createHash("sha256"); for await (const raw of createReadStream(name)) hash.update(raw);
  const manifest = { backup: name, bytes: (await stat(name)).size, sha256: hash.digest("hex") };
  await writeFile(`${name}.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(manifest));
} catch { console.error(JSON.stringify({ error: "BACKUP_FAILED" })); process.exitCode = 1; }
