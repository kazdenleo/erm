/**
 * Certificates Controller
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import certificatesService from '../services/certificates.service.js';
import certificatesStatusSyncService from '../services/certificatesStatusSync.service.js';
import certificatesImportService from '../services/certificatesImport.service.js';
import ozonCertificatesPushService from '../services/ozonCertificatesPush.service.js';
import ymCertificatesPushService from '../services/ymCertificatesPush.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { OZON_ACCORDANCE_TYPES } from '../utils/ozonCertificateMap.js';
import { YM_DOCUMENT_TYPES } from '../utils/ymCertificateMap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATUS_SYNC_COOLDOWN_MS = 30_000;

function noAccountError() {
  const err = new Error('Нет привязки к аккаунту');
  err.statusCode = 403;
  return err;
}

class CertificatesController {
  constructor() {
    this._rootDir = path.resolve(__dirname, '../../');
    this._statusSyncAt = new Map();
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
      const deleteOzon = this._truthyQuery(req.query.deleteOzon, false);
      const deleteYm = this._truthyQuery(req.query.deleteYm, false);
      if (deleteOzon || deleteYm) {
        await this._deleteOnMarketplaces(id, { profileId, organizationId: this._organizationId(req), deleteOzon, deleteYm });
      }
      await certificatesService.delete(id, { profileId });
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  }

  /** Удаляет в кабинетах; при ошибке локальный сертификат остаётся, а уже удалённая связь снимается. */
  async _deleteOnMarketplaces(id, { profileId, organizationId, deleteOzon, deleteYm }) {
    const cert = await certificatesService.getById(id, { profileId });
    const opts = { profileId, organizationId };
    const done = [];
    const failed = [];

    if (deleteOzon && cert.ozon_certificate_id) {
      try {
        await ozonCertificatesPushService.deleteRemote(cert.ozon_certificate_id, opts);
        await query(
          `UPDATE certificates
              SET ozon_certificate_id = NULL, ozon_status_code = NULL, ozon_synced_at = NULL, ozon_last_error = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND profile_id = $2::bigint`,
          [id, profileId]
        );
        done.push('Ozon');
      } catch (e) {
        failed.push(e?.message || String(e));
      }
    }
    if (deleteYm && cert.ym_document_id) {
      try {
        await ymCertificatesPushService.deleteRemote(cert.ym_document_id, opts);
        await query(
          `UPDATE certificates
              SET ym_document_id = NULL, ym_status_code = NULL, ym_synced_at = NULL, ym_last_error = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND profile_id = $2::bigint`,
          [id, profileId]
        );
        done.push('Яндекс.Маркет');
      } catch (e) {
        failed.push(e?.message || String(e));
      }
    }

    if (failed.length) {
      const prefix = done.length ? `Удалён на: ${done.join(', ')}. ` : '';
      const err = new Error(`${prefix}${failed.join('; ')}. Сертификат в ERP не удалён.`);
      err.statusCode = 400;
      throw err;
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

  async pushToYm(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      const body = req.body || {};
      const result = await ymCertificatesPushService.pushCertificate(id, {
        profileId,
        organizationId: this._organizationId(req),
        bindProducts: body.bindProducts !== false && body.bind_products !== false,
        forceCreate: body.forceCreate === true || body.force_create === true,
        documentType: body.documentType ?? body.document_type ?? null,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  }

  async syncStatuses(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const organizationId = this._organizationId(req);
      const cooldownKey = `${profileId}:${organizationId ?? ''}`;
      const now = Date.now();
      const last = this._statusSyncAt.get(cooldownKey) || 0;
      if (now - last < STATUS_SYNC_COOLDOWN_MS && req.body?.force !== true) {
        return res.status(200).json({ ok: true, data: { skipped: true } });
      }
      this._statusSyncAt.set(cooldownKey, now);

      const data = await certificatesStatusSyncService.syncForProfile(profileId, { organizationId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async importFromMarketplaces(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const data = await certificatesImportService.importFromMarketplaces({
        profileId,
        organizationId: this._organizationId(req),
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async syncStatus(req, res, next) {
    try {
      const profileId = this._requireProfile(req);
      const { id } = req.params;
      await certificatesService.getById(id, { profileId });
      const sync = await certificatesStatusSyncService.syncForProfile(profileId, {
        organizationId: this._organizationId(req),
        certificateId: id,
      });
      const certificate = await certificatesService.getById(id, { profileId });
      return res.status(200).json({ ok: true, data: { ...sync, certificate } });
    } catch (e) {
      next(e);
    }
  }

  async ymDocumentTypes(req, res, next) {
    try {
      this._requireProfile(req);
      return res.status(200).json({ ok: true, data: YM_DOCUMENT_TYPES });
    } catch (e) {
      next(e);
    }
  }
}

export default new CertificatesController();
