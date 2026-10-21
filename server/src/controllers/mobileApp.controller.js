/**
 * Публичные эндпоинты мобильного APK и QR для настроек.
 */

import fs from 'fs';
import {
  apkAvailable,
  buildQrPng,
  getApkPath,
  getReleaseInfo,
} from '../services/mobileApp.service.js';

class MobileAppController {
  getInfo(req, res) {
    return res.status(200).json({ ok: true, data: getReleaseInfo(req) });
  }

  async getQr(req, res, next) {
    try {
      const info = getReleaseInfo(req);
      if (!info.available) {
        return res.status(404).json({ ok: false, message: 'APK ещё не загружен на сервер' });
      }
      const png = await buildQrPng(info.downloadUrl);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Disposition', 'inline; filename="erm-warehouse-qr.png"');
      return res.status(200).send(png);
    } catch (error) {
      next(error);
    }
  }

  download(req, res, next) {
    try {
      if (!apkAvailable()) {
        return res.status(404).json({ ok: false, message: 'APK ещё не загружен на сервер' });
      }
      const info = getReleaseInfo(req);
      const filePath = getApkPath();
      const version = info.versionCode || info.version || 'latest';
      const fileName = `erm-warehouse-${version}.apk`;
      const size = fs.statSync(filePath).size;
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'no-cache');
      // sendFile задаёт длину и корректно отдаёт файл для установщика Android.
      return res.sendFile(filePath, { acceptRanges: true }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new MobileAppController();
