import { AppError } from "./errors.js";

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("INVALID_INPUT", 400, "Dữ liệu đầu vào không hợp lệ");
  return result.data;
}
