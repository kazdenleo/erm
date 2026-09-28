/**
 * Certificates Controller
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import certificatesService from '../services/certificates.service.js';
import ozonCertificatesPushService from '../services/ozonCertificatesPush.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { OZON_ACCORDANCE_TYPES } from '../utils/ozonCertificateMap.js';

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

  _organizationId(req) {
    const fromBody = req.body?.organizationId ?? req.body?.organization_id;
    const fromQuery = req.query?.organizationId ?? req.query?.organization_id;
    const fromHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
    const raw = fromBody ?? fromQuery ?? fromHeader;
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async pushToOzon(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      const body = req.body || {};
      const result = await ozonCertificatesPushService.pushCertificate(id, {
        profileId,
        organizationId: this._organizationId(req),
        bindProducts: body.bindProducts !== false && body.bind_products !== false,
        forceCreate: body.forceCreate === true || body.force_create === true,
        name: body.name ?? null,
        accordanceTypeCode: body.accordanceTypeCode ?? body.accordance_type_code ?? null,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  }

  async ozonAccordanceTypes(req, res, next) {
    try {
      this._requireProfile(req);
      return res.status(200).json({ ok: true, data: OZON_ACCORDANCE_TYPES });
    } catch (e) {
      next(e);
    }
  }
}

export default new CertificatesController();
