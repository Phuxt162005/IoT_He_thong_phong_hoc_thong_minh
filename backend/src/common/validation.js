import { AppError } from "./errors.js";
import { z } from "zod";

export const idSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine((v) => BigInt(v) <= 9223372036854775807n);
export const pagination = {
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("INVALID_INPUT", 400, "Dữ liệu đầu vào không hợp lệ");
  return result.data;
}
