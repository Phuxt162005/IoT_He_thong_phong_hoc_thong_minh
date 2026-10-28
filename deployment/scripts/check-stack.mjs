import { spawn } from "node:child_process";
import { compose, docker } from "./docker-process.mjs";
const run = (file, args = [], capture = false) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { windowsHide: true, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  let output = ""; child.stdout?.on("data", (raw) => { output += raw; }); child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error("STACK_CHECK_FAILED")));
});
try {
  await run("deployment/scripts/smoke.mjs");
  await run("deployment/scripts/demo-backend.mjs");
  const backup = JSON.parse(await run("deployment/scripts/backup.mjs", [], true));
  await run("deployment/scripts/restore-check.mjs", [backup.backup]);
  const before = await docker([...compose, "--profile", "app", "logs", "--no-color", "backend"]);
  await docker([...compose, "--profile", "app", "stop", "backend"]);
  const after = await docker([...compose, "--profile", "app", "logs", "--no-color", "backend"]);
  if ((after.match(/server.stopped/g) ?? []).length <= (before.match(/server.stopped/g) ?? []).length) throw new Error("GRACEFUL_STOP_FAILED");
  await docker([...compose, "--profile", "app", "start", "backend"]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${process.env.BASE_URL ?? "http://127.0.0.1:3000"}/ready`)).ok; } catch { /* wait for listener */ }
    if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("RESTART_NOT_READY");
  await run("deployment/scripts/smoke.mjs");
  console.log(JSON.stringify({ docker_stack: true, simulated_flow: true, backup_restore: true, graceful_stop: true, restart: true }));
} catch { console.error(JSON.stringify({ error: "STACK_CHECK_FAILED" })); process.exitCode = 1; }
