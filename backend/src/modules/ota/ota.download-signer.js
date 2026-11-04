import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../common/errors.js";

const encode = (value) => Buffer.from(value).toString("base64url");

export class OtaDownloadSigner {
  constructor({ baseUrl, secret }) {
    if (!baseUrl || !secret || secret.length < 32) {
      throw new TypeError(
        "Cần OTA_DOWNLOAD_BASE_URL và OTA_DOWNLOAD_SECRET hợp lệ",
      );
    }

    const url = new URL(baseUrl);
    if (url.protocol !== "https:") {
      throw new TypeError("OTA download URL bắt buộc sử dụng HTTPS");
    }

    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.secret = secret;
  }

  sign(storagePath, expiresAt) {
    const payload = encode(
      JSON.stringify({
        storage_path: storagePath,
        expires_at: expiresAt.getTime(),
      }),
    );

    const signature = createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");

    return `${this.baseUrl}/ota/download/${payload}/${signature}`;
  }

  async create(storagePath, expiresAt) {
    return this.sign(storagePath, expiresAt);
  }

  verify(payload, signature) {
    try {
      const expected = createHmac("sha256", this.secret)
        .update(payload)
        .digest();

      const actual = Buffer.from(signature, "base64url");

      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        throw new Error("Invalid signature");
      }

      const data = JSON.parse(Buffer.from(payload, "base64url").toString());

      if (
        typeof data.storage_path !== "string" ||
        !Number.isSafeInteger(data.expires_at) ||
        data.expires_at <= Date.now()
      ) {
        throw new Error("Expired or invalid token");
      }

      return data;
    } catch {
      throw new AppError(
        "OTA_DOWNLOAD_TOKEN_INVALID",
        403,
        "URL tải firmware không hợp lệ hoặc đã hết hạn",
      );
    }
  }
}
