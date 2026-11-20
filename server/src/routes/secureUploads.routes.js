/**
 * Авторизованная выдача чувствительных файлов из uploads/
 * (сертификаты, обращения). Публично остаются только products / rich-content / video-covers.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

const ALLOWED_PREFIXES = Object.freeze(['certificates', 'inquiries']);

const router = express.Router();

router.get(
  '*',
  requireAuth,
  wrapAsync(async (req, res) => {
    const rel = String(req.path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      return res.status(400).json({ ok: false, message: 'Некорректный путь' });
    }
    const top = rel.split('/')[0];
    if (!ALLOWED_PREFIXES.includes(top)) {
      return res.status(404).json({ ok: false, message: 'Не найдено' });
    }
    const abs = path.resolve(UPLOADS_ROOT, rel);
    if (!abs.startsWith(UPLOADS_ROOT + path.sep) && abs !== UPLOADS_ROOT) {
      return res.status(400).json({ ok: false, message: 'Некорректный путь' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ ok: false, message: 'Файл не найден' });
    }
    return res.sendFile(abs);
  })
);

export default router;
