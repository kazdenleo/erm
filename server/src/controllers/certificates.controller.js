/**
 * Certificates Controller
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import certificatesService from '../services/certificates.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function noAccountError() {
  const err = new Error('Нет привязки к аккаунту');
  err.statusCode = 403;
  return err;
}

class CertificatesController {
  constructor() {
    this._rootDir = path.resolve(__dirname, '../../');
  }

  _listScope(req) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY) return { empty: true, profileId: null };
    return { empty: false, profileId: tid };
  }

  _requireProfile(req) {
    const tid = tenantListProfileId(req);
    if (tid === TENANT_LIST_EMPTY || tid == null) {
      throw noAccountError();
    }
    return tid;
  }

  _truthyQuery(v, defaultValue = true) {
    if (v == null || v === '') return defaultValue;
    const s = String(v).trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'no') return false;
    if (s === 'true' || s === '1' || s === 'yes') return true;
    return defaultValue;
  }

  async getAll(req, res, next) {
    try {
      const scope = this._listScope(req);
      if (scope.empty) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const opts = {
        brandId: req.query.brandId ?? null,
        userCategoryId: req.query.userCategoryId ?? null,
        includeExpired: this._truthyQuery(req.query.includeExpired, true),
      };
      if (scope.profileId != null) opts.profileId = scope.profileId;
      const data = await certificatesService.getAll(opts);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const scope = this._listScope(req);
      if (scope.empty) throw noAccountError();
      const { id } = req.params;
      const data = await certificatesService.getById(
        id,
        scope.profileId != null ? { profileId: scope.profileId } : {}
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async create(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const created = await certificatesService.create(req.body || {}, { profileId });
      return res.status(201).json({ ok: true, data: created });
    } catch (e) {
      next(e);
    }
  }

  async update(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      const updated = await certificatesService.update(id, req.body || {}, { profileId });
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }

  async delete(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      await certificatesService.delete(id, { profileId });
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  }

  async uploadPhoto(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      await certificatesService.getById(id, { profileId });
      const filename = req.file?.filename || '';
      if (!filename) {
        return res.status(400).json({ ok: false, message: 'Файл не получен. Отправьте multipart с полем photo.' });
      }
      const rel = `/uploads/certificates/${String(id)}/${filename}`;
      const updated = await certificatesService.update(id, { photo_url: rel }, { profileId });
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }

  async deletePhoto(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      const cert = await certificatesService.getById(id, { profileId });
      const url = cert?.photo_url || cert?.photoUrl || null;
      if (url) {
        const rel = String(url).replace(/^\/+/, '');
        const filePath = path.resolve(this._rootDir, rel);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
      }
      const updated = await certificatesService.update(id, { photo_url: null }, { profileId });
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }
}

export default new CertificatesController();
