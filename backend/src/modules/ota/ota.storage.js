import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export class LocalFirmwareStorage {
  constructor({ directory }) {
    if (!directory) throw new TypeError("Cần cấu hình thư mục firmware");
    this.directory = path.resolve(directory);
  }

  async stat(storagePath) {
    return stat(this.resolve(storagePath));
  }
  createReadStream(storagePath) {
    return createReadStream(this.resolve(storagePath));
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async save({ firmwareId, buffer }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new TypeError("Firmware buffer không hợp lệ");
    }

    await this.ensureDirectory();

    const fileName = `${firmwareId || randomUUID()}.bin`;
    const filePath = path.join(this.directory, fileName);

    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });

    return { storage_path: fileName };
  }

  resolve(storagePath) {
    if (
      typeof storagePath !== "string" ||
      !/^[0-9a-f-]{36}\.bin$/i.test(storagePath)
    ) {
      throw new Error("Đường dẫn firmware không hợp lệ");
    }

    const filePath = path.resolve(this.directory, storagePath);
    if (path.dirname(filePath) !== this.directory) {
      throw new Error("Đường dẫn firmware nằm ngoài thư mục cho phép");
    }

    return filePath;
  }

  async read(storagePath) {
    return readFile(this.resolve(storagePath));
  }

  async remove(storagePath) {
    try {
      await unlink(this.resolve(storagePath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async open(storagePath) {
    return this.read(storagePath);
  }
}
