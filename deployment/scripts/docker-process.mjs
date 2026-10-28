import { spawn } from "node:child_process";
export const compose = ["compose", "--env-file", ".env", "-f", "deployment/compose.yml"];
export function docker(args, { input, output } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks = [];
    if (input) input.pipe(child.stdin);
    if (output) child.stdout.pipe(output); else child.stdout.on("data", (raw) => chunks.push(raw));
    const fail = (error) => { child.kill(); reject(error); };
    input?.on("error", fail); output?.on("error", fail);
    child.stderr.resume();
    child.stdin?.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8").trim()) : reject(new Error("DOCKER_OPERATION_FAILED")));
  });
}
