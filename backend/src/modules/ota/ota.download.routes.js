import { Router } from "express";
import { AppError, requireFound } from "../../common/errors.js";

export function createOtaDownloadRoutes({ pool, storage, signer }) {
  const router = Router();

  router.get("/ota/download/:token/:signature", async (req, res) => {
    const data = signer.verify(req.params.token, req.params.signature);

    const result = await pool.query(
      `SELECT storage_path, file_size
       FROM firmware_releases
       WHERE firmware_id=$1 AND status='PUBLISHED'`,
      [data.firmware_id],
    );

    const firmware = requireFound(
      result.rows[0],
      "Firmware không tồn tại hoặc đã bị thu hồi",
    );

    if (firmware.storage_path !== data.storage_path) {
      throw new AppError(
        "OTA_DOWNLOAD_MISMATCH",
        403,
        "Thông tin file tải không khớp firmware",
      );
    }

    const fileStat = await storage.stat(data.storage_path);

    if (
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size !== Number(firmware.file_size)
    ) {
      throw new AppError(
        "FIRMWARE_NOT_FOUND",
        404,
        "Không tìm thấy file firmware hợp lệ",
      );
    }

    res.status(200);
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(fileStat.size),
      "Content-Disposition": 'attachment; filename="firmware.bin"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    const stream = storage.createReadStream(data.storage_path);

    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  });

  return router;
}
