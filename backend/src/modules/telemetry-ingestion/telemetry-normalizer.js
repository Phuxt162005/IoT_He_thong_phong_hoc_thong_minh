import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../common/errors.js";

const code = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const eventId = z.string().min(1).max(64);
const temperature = z.number().finite().min(-10).max(60);
const humidity = z.number().finite().min(0).max(100);
const lux = z.number().finite().min(0).max(65535);
const canonical = z.object({ msg_id: eventId, device_id: code, room_id: code, timestamp: z.number().int().min(0).max(8640000000000000), data: z.object({ temperature, humidity, lux: lux.int(), occupancy: z.boolean() }).strict() }).strict();
const legacy = z.object({ messageType: z.literal("telemetry"), eventId, deviceId: code, roomCode: code, timestamp: z.union([z.literal(""), z.iso.datetime({ offset: true })]).optional(), temperatureC: temperature, humidityPercent: humidity, illuminanceLux: lux, occupancy: z.boolean().optional() }).strict();

export function normalizeTelemetry(input) {
  const isLegacy = input != null && typeof input === "object" && Object.hasOwn(input, "eventId");
  const parsed = (isLegacy ? legacy : canonical).safeParse(input);
  if (!parsed.success) throw new AppError("INVALID_TELEMETRY", 400, "Dữ liệu cảm biến không hợp lệ");
  const value = parsed.data;
  const event = isLegacy ? {
    eventId: value.eventId, deviceId: value.deviceId, roomCode: value.roomCode,
    timestampMs: value.timestamp ? Date.parse(value.timestamp) : null,
    temperatureC: value.temperatureC, humidityPercent: value.humidityPercent, illuminanceLux: value.illuminanceLux, occupancy: value.occupancy ?? null,
  } : {
    eventId: value.msg_id, deviceId: value.device_id, roomCode: value.room_id,
    timestampMs: value.timestamp, temperatureC: value.data.temperature,
    humidityPercent: value.data.humidity, illuminanceLux: value.data.lux, occupancy: value.data.occupancy,
  };
  const payloadHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return { ...event, payloadHash, legacy: isLegacy };
}
