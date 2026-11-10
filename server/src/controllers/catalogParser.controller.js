/**
 * Auth-gated catalog scraper installer download (Автолюбитель only).
 */

import fs from 'fs';
import {
  getReleaseInfo,
  getSetupPath,
  isCatalogParserAllowed,
  setupAvailable,
} from '../services/catalogParser.service.js';

class CatalogParserController {
  async getInfo(req, res, next) {
    try {
      const allowed = await isCatalogParserAllowed(req.user);
      if (!allowed) {
        return res.status(200).json({
          ok: true,
          data: { allowed: false, available: false },
        });
      }
      return res.status(200).json({
        ok: true,
        data: { allowed: true, ...getReleaseInfo() },
      });
    } catch (error) {
      next(error);
    }
  }

  async download(req, res, next) {
    try {
      const allowed = await isCatalogParserAllowed(req.user);
      if (!allowed) {
        return res.status(403).json({
          ok: false,
          message: 'Установщик доступен только аккаунту «Автолюбитель»',
        });
      }
      if (!setupAvailable()) {
        return res.status(404).json({ ok: false, message: 'Установщик ещё не загружен на сервер' });
      }
      const info = getReleaseInfo();
      const filePath = getSetupPath();
      const fileName = info.fileName || 'SborshikKatalogov-setup.exe';
      const size = fs.statSync(filePath).size;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(filePath, { acceptRanges: true }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new CatalogParserController();
