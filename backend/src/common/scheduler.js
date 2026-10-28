export function startJob(name, work, { intervalMs, logger }) {
  let pending = null;
  const run = () => {
    if (pending) return;
    pending = Promise.resolve().then(work).catch((error) => logger.warn("scheduler.job_failed", { job: name, code: error.code ?? "JOB_ERROR" })).finally(() => { pending = null; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  return { async stop() { clearInterval(timer); await pending; } };
}
