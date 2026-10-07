/**
 * TN VED Controller
 */

import tnVedService from '../services/tnVed.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class TnVedController {
  async searchCodes(req, res, next) {
    try {
      const data = await tnVedService.searchCodes({
        q: req.query.q ?? req.query.query ?? '',
        limit: req.query.limit,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getCode(req, res, next) {
    try {
      const data = await tnVedService.getCode(req.params.code);
      return res.status(200).json({ ok: true, data: data || null });
    } catch (e) {
      next(e);
    }
  }

  async getDirectoryInfo(req, res, next) {
    try {
      const data = await tnVedService.getDirectoryInfo();
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async checkCompatibility(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const q = req.query || {};
      const data = await tnVedService.checkMarketplaceCompatibility({
        code: q.code,
        userCategoryId: q.userCategoryId ?? q.user_category_id ?? null,
        wbSubjectId: q.wbSubjectId ?? q.wb_subject_id ?? null,
        ozonDescId: q.ozonDescId ?? q.ozon_description_category_id ?? null,
        ozonTypeId: q.ozonTypeId ?? q.ozon_type_id ?? null,
        profileId: tid,
        organizationId: q.organizationId ?? q.organization_id ?? null,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getBindings(req, res, next) {
    try {
      const data = await tnVedService.getBindings({
        brandId: req.query.brandId ?? null,
        userCategoryId: req.query.userCategoryId ?? null,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getBindingById(req, res, next) {
    try {
      const data = await tnVedService.getBindingById(req.params.id);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async createBinding(req, res, next) {
    try {
      const created = await tnVedService.createBinding(req.body || {});
      return res.status(201).json({ ok: true, data: created });
    } catch (e) {
      next(e);
    }
  }

  async updateBinding(req, res, next) {
    try {
      const updated = await tnVedService.updateBinding(req.params.id, req.body || {});
      return res.status(200).json({ ok: true, data: updated });
    } catch (e) {
      next(e);
    }
  }

  async deleteBinding(req, res, next) {
    try {
      await tnVedService.deleteBinding(req.params.id);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  }
}

export default new TnVedController();
