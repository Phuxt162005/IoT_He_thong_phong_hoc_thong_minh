export class AppError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function requireFound(value, message = "Không tìm thấy dữ liệu") {
  if (!value) throw new AppError("NOT_FOUND", 404, message);
  return value;
}
