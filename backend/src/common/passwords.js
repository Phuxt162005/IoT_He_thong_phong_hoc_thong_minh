import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) throw new TypeError("Mật khẩu phải có 12–128 ký tự");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64, options);
  return `scrypt-v1$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 128 || typeof encoded !== "string") return false;
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const derived = await scrypt(password, match[1], 64, options);
  return timingSafeEqual(derived, Buffer.from(match[2], "hex"));
}
