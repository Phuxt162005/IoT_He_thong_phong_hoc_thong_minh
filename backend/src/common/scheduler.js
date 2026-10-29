export function startJob(name, work, { intervalMs, logger }) {
  let pending = null;
  const run = () => {
    // Không chạy chồng cùng một job nếu lượt trước chưa xong; các job khác vẫn chạy độc lập.
    if (pending) return;
    pending = Promise.resolve().then(work).catch((error) => logger.warn("scheduler.job_failed", { job: name, code: error.code ?? "JOB_ERROR" })).finally(() => { pending = null; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  // Dừng lịch mới nhưng vẫn chờ lượt đang chạy hoàn tất trước khi đóng database/MQTT.
  return { async stop() { clearInterval(timer); await pending; } };
}
