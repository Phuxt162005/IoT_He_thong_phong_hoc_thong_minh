export class MonitoringError extends Error {
  constructor(message, code = "MONITORING_ERROR") {
    super(message);
    this.name = "MonitoringError";
    this.code = code;
  }
}
