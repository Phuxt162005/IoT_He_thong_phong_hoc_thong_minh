export class AnomalyDetectionError extends Error {
  constructor(message, code = "ANOMALY_DETECTION_ERROR") {
    super(message);
    this.name = "AnomalyDetectionError";
    this.code = code;
  }
}
