export class TelemetryIngestionError extends Error {
  constructor(message, code = "TELEMETRY_INGESTION_ERROR") {
    super(message);
    this.name = "TelemetryIngestionError";
    this.code = code;
  }
}

export class TelemetryIngestionService {
  constructor({ repository, now = () => new Date().toISOString() }) {
    if (!repository) throw new TypeError("Cần telemetry repository");
    this.repository = repository;
    this.now = now;
  }

  validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TelemetryIngestionError(
        "Payload không hợp lệ",
        "INVALID_PAYLOAD",
      );
    }

    for (const key of ["eventId", "deviceId", "roomCode"]) {
      if (typeof payload[key] !== "string" || !payload[key].trim()) {
        throw new TelemetryIngestionError(
          `Thiếu trường ${key}`,
          "MISSING_FIELD",
        );
      }
    }

    for (const key of ["temperatureC", "humidityPercent", "illuminanceLux"]) {
      if (typeof payload[key] !== "number" || !Number.isFinite(payload[key])) {
        throw new TelemetryIngestionError(
          `Trường ${key} phải là số hữu hạn`,
          "INVALID_MEASUREMENT",
        );
      }
    }

    if (payload.humidityPercent < 0 || payload.humidityPercent > 100) {
      throw new TelemetryIngestionError(
        "Độ ẩm nằm ngoài khoảng 0–100%",
        "OUT_OF_RANGE",
      );
    }

    if (payload.illuminanceLux < 0) {
      throw new TelemetryIngestionError("Độ rọi không được âm", "OUT_OF_RANGE");
    }

    if (payload.timestamp && typeof payload.timestamp !== "string") {
      throw new TelemetryIngestionError(
        "timestamp phải là chuỗi",
        "INVALID_TIMESTAMP",
      );
    }
  }

  async ingest(payload) {
    this.validate(payload);

    const existing = await this.repository.findByEventId(payload.eventId);
    if (existing) {
      // Cùng eventId được xác nhận lại, không tạo bản ghi thứ hai.
      return {
        status: "STORED",
        eventId: payload.eventId,
        duplicate: true,
      };
    }

    const event = {
      ...payload,
      receivedAt: this.now(),
    };

    const result = await this.repository.saveIfAbsent(event);

    // saveIfAbsent phải được thực hiện nguyên tử trong repository database thật.
    return {
      status: "STORED",
      eventId: payload.eventId,
      duplicate: !result.inserted,
    };
  }

  buildAck(result) {
    return {
      messageType: "telemetry_ack",
      eventId: result.eventId,
      status: result.status,
      duplicate: result.duplicate,
      timestamp: this.now(),
    };
  }
}
