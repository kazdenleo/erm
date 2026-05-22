/**
 * FBO Supplies Controller
 */

import fboSuppliesService from '../services/fboSupplies.service.js';
import fboSuppliesImportService from '../services/fboSuppliesImport.service.js';
import fboSuppliesExportService from '../services/fboSuppliesExport.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function setAttachmentXlsx(res, filename) {
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`);
}

class FboSuppliesController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const status = req.query.status?.trim() || null;
      const marketplace = req.query.marketplace?.trim() || null;
      const data = await fboSuppliesService.list({
        profileId: tid,
        limit,
        status,
        marketplace,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.getById(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async create(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const data = await fboSuppliesService.create(req.body || {}, { profileId, userId });
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 409) {
        return res.status(e.statusCode).json({ ok: false, message: e.message, code: e.code });
      }
      next(e);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.update(id, req.body || {}, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async advanceStatus(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.advanceStatus(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.delete(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async downloadImportTemplateExcel(req, res, next) {
    try {
      const buffer = await fboSuppliesExportService.buildImportTemplateBuffer();
      const date = new Date().toISOString().slice(0, 10);
      const filename = `fbo_supplies_import_template_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setAttachmentXlsx(res, filename);
      res.send(buffer);
    } catch (e) {
      next(e);
    }
  }

  async previewApiImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const { marketplace, organizationId, daysBack } = req.body || {};
      const data = await fboSuppliesImportService.fetchMarketplacePreview({
        marketplace,
        profileId,
        organizationId,
        daysBack,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async previewExcelImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      if (!req.file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Загрузите файл Excel (.xlsx)' });
      }
      const data = await fboSuppliesImportService.parseExcelBuffer(req.file.buffer, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async confirmImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const { supplies, source } = req.body || {};
      const rows = (supplies || []).map((s) => ({
        ...s,
        source: s.source || source || 'api',
      }));
      const data = await fboSuppliesImportService.confirmImport(rows, { profileId, userId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 409) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new FboSuppliesController();
