/**
 * TN VED Controller
 */

import tnVedService from '../services/tnVed.service.js';

class TnVedController {
  async searchCodes(req, res, next) {
    try {
      const data = tnVedService.searchCodes({
        q: req.query.q ?? req.query.query ?? '',
        limit: req.query.limit,
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
