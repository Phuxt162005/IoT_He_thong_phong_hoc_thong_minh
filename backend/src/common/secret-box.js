import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// Mã hóa secret cần gửi lại cho broker; khác với băm mật khẩu vì dữ liệu này phải giải mã được.
export class SecretBox {
  constructor(hexKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey ?? "")) throw new TypeError("DEVICE_SECRET_KEY phải là 32 byte hex");
    this.key = Buffer.from(hexKey, "hex");
  }
  seal(value, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    // Ràng buộc bản mã với thiết bị/thao tác; không thể chuyển bản mã sang ngữ cảnh khác.
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString("base64url")).join(".");
  }
  open(value, context) {
    const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
  }
}
