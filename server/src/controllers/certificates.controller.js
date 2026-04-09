/**
 * Certificates Controller
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import certificatesService from '../services/certificates.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CertificatesController {
  constructor() {
    this._rootDir = path.resolve(__dirname, '../../');
  }

  async getAll(req, res, next) {
    try {
      const opts = {
        brandId: req.query.brandId ?? null,
        userCategoryId: req.query.userCategoryId ?? null,
      };
      const data = await certificatesService.getAll(opts);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const data = await certificatesService.getById(id);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async create(req, res, next) {
    try {
      const created = await certificatesService.create(req.body || {});
      return res.status(201).json({ ok: true, data: created });
    } catch (e) {
      next(e);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await certificatesService.update(id, req.body || {});
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      await certificatesService.delete(id);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  }

  async deletePhoto(req, res, next) {
    try {
      const { id } = req.params;
      const cert = await certificatesService.getById(id);
      const url = cert?.photo_url || cert?.photoUrl || null;
      if (url) {
        const rel = String(url).replace(/^\/+/, '');
        const filePath = path.resolve(this._rootDir, rel);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
      }
      const updated = await certificatesService.update(id, { photo_url: null });
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }
}

export default new CertificatesController();

