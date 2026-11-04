import { Router } from "express";
import { AppError } from "../../common/errors.js";

export function createOtaDownloadRoutes({ storage, signer }) {
  const router = Router();

  router.get("/ota/download/:token/:signature", async (req, res) => {
    const data = signer.verify(req.params.token, req.params.signature);
    const fileStat = await storage.stat(data.storage_path);

    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new AppError(
        "FIRMWARE_NOT_FOUND",
        404,
        "Không tìm thấy file firmware",
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
