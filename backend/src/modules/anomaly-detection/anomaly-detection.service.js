import { AnomalyDetectionError } from "./anomaly-detection.errors.js";

const METRICS = ["temperatureC", "humidityPercent", "illuminanceLux"];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class AnomalyDetectionService {
  constructor({
    repository,
    now = () => new Date().toISOString(),
    minSamples = 8,
    windowSize = 30,
    threshold = 3.5,
  }) {
    if (!repository) throw new TypeError("Cần anomaly repository");
    if (!Number.isInteger(minSamples) || minSamples < 3) {
      throw new TypeError("minSamples phải là số nguyên từ 3 trở lên");
    }
    if (!Number.isInteger(windowSize) || windowSize < minSamples) {
      throw new TypeError("windowSize phải lớn hơn hoặc bằng minSamples");
    }
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new TypeError("threshold phải là số dương");
    }

    this.repository = repository;
    this.now = now;
    this.minSamples = minSamples;
    this.windowSize = windowSize;
    this.threshold = threshold;
  }

  validateTelemetry(telemetry) {
    if (
      !telemetry ||
      typeof telemetry !== "object" ||
      Array.isArray(telemetry)
    ) {
      throw new AnomalyDetectionError(
        "Telemetry không hợp lệ",
        "INVALID_PAYLOAD",
      );
    }
    if (typeof telemetry.deviceId !== "string" || !telemetry.deviceId.trim()) {
      throw new AnomalyDetectionError("Thiếu deviceId", "MISSING_DEVICE_ID");
    }
    if (
      telemetry.eventId !== undefined &&
      (typeof telemetry.eventId !== "string" || !telemetry.eventId.trim())
    ) {
      throw new AnomalyDetectionError(
        "eventId không hợp lệ",
        "INVALID_EVENT_ID",
      );
    }
    if (
      telemetry.timestamp !== undefined &&
      (typeof telemetry.timestamp !== "string" ||
        !Number.isFinite(Date.parse(telemetry.timestamp)))
    ) {
      throw new AnomalyDetectionError(
        "timestamp không hợp lệ",
        "INVALID_TIMESTAMP",
      );
    }

    const measurements = {};
    for (const metric of METRICS) {
      if (telemetry[metric] === undefined) continue;
      if (
        typeof telemetry[metric] !== "number" ||
        !Number.isFinite(telemetry[metric])
      ) {
        throw new AnomalyDetectionError(
          `Trường ${metric} phải là số hữu hạn`,
          "INVALID_MEASUREMENT",
        );
      }
      measurements[metric] = telemetry[metric];
    }

    if (Object.keys(measurements).length === 0) {
      throw new AnomalyDetectionError(
        "Telemetry không có chỉ số cảm biến được hỗ trợ",
        "NO_SUPPORTED_MEASUREMENTS",
      );
    }

    if (
      measurements.humidityPercent !== undefined &&
      (measurements.humidityPercent < 0 || measurements.humidityPercent > 100)
    ) {
      throw new AnomalyDetectionError(
        "Độ ẩm phải nằm trong khoảng 0–100%",
        "OUT_OF_RANGE",
      );
    }
    if (
      measurements.illuminanceLux !== undefined &&
      measurements.illuminanceLux < 0
    ) {
      throw new AnomalyDetectionError("Độ rọi không được âm", "OUT_OF_RANGE");
    }

    return measurements;
  }

  async analyzeTelemetry(telemetry) {
    const measurements = this.validateTelemetry(telemetry);
    const { deviceId, eventId } = telemetry;

    const previous = await this.repository.getProcessedEvent(deviceId, eventId);
    if (previous) return { ...previous, duplicate: true };

    const findings = [];

    for (const [metric, value] of Object.entries(measurements)) {
      const history = await this.repository.getBaseline(deviceId, metric);

      if (history.length < this.minSamples) {
        await this.repository.appendBaseline(
          deviceId,
          metric,
          value,
          this.windowSize,
        );
        findings.push({
          metric,
          value,
          status: "WARMING_UP",
          anomaly: false,
          baselineSamples: history.length,
        });
        continue;
      }

      const center = median(history);
      const deviations = history.map((sample) => Math.abs(sample - center));
      const mad = median(deviations);

      // Robust Z-score: ít nhạy với các điểm ngoại lai hơn mean/std.
      const score =
        mad === 0
          ? value === center
            ? 0
            : null
          : (0.6745 * (value - center)) / mad;

      const anomaly =
        mad === 0 ? value !== center : Math.abs(score) >= this.threshold;

      const finding = {
        metric,
        value,
        status: anomaly ? "ANOMALY" : "NORMAL",
        anomaly,
        baselineSamples: history.length,
        median: center,
        mad,
        score,
        threshold: this.threshold,
        reason: anomaly
          ? mad === 0
            ? "DEVIATION_FROM_CONSTANT_BASELINE"
            : "ROBUST_Z_SCORE_EXCEEDED"
          : "WITHIN_BASELINE",
      };

      findings.push(finding);

      // Không đưa điểm bất thường vào baseline để tránh làm lệch hành vi chuẩn.
      if (!anomaly) {
        await this.repository.appendBaseline(
          deviceId,
          metric,
          value,
          this.windowSize,
        );
      }
    }

    const result = {
      eventId: eventId ?? null,
      deviceId,
      timestamp: telemetry.timestamp ?? null,
      analyzedAt: this.now(),
      anomalyDetected: findings.some((item) => item.anomaly),
      findings,
      duplicate: false,
    };

    await this.repository.saveProcessedEvent(deviceId, eventId, result);
    return result;
  }

  async resetBaseline(deviceId, metric) {
    if (typeof deviceId !== "string" || !deviceId.trim()) {
      throw new AnomalyDetectionError(
        "deviceId không hợp lệ",
        "INVALID_DEVICE_ID",
      );
    }
    if (!METRICS.includes(metric)) {
      throw new AnomalyDetectionError(
        "Chỉ số cảm biến không được hỗ trợ",
        "INVALID_METRIC",
      );
    }
    await this.repository.clearBaseline(deviceId, metric);
  }
}
