/**
 * Purchases Controller
 * Закупки и приёмки по закупке (сканирование).
 */

import purchasesService from '../services/purchases.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class PurchasesController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const status = req.query.status != null && String(req.query.status).trim() !== '' ? String(req.query.status).trim() : null;
      const profileId = tid;
      const data = await purchasesService.list({ profileId, limit, status });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.getById(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async create(req, res, next) {
    try {
      const { supplierId, organizationId, warehouseId, items, note } = req.body || {};
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.create(
        { supplierId, organizationId, warehouseId, items, note },
        { userId, profileId }
      );
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async appendDraftItems(req, res, next) {
    try {
      const { id } = req.params;
      const { items } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.appendDraftItems(id, { items }, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async removeDraftLineItem(req, res, next) {
    try {
      const { id, itemId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const reduceBy = req.body?.reduceBy ?? req.query?.reduceBy;
      const data = await purchasesService.removeDraftLineItem(id, itemId, { profileId, reduceBy });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async markOrdered(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.markOrdered(id, { userId, profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async updatePurchase(req, res, next) {
    try {
      const { id } = req.params;
      const { supplierId, organizationId, warehouseId, note } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.updatePurchase(id, { supplierId, organizationId, warehouseId, note }, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async updatePurchaseItem(req, res, next) {
    try {
      const { id, itemId } = req.params;
      const { purchasePrice } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.updatePurchaseItem(id, itemId, { purchasePrice }, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async createReceipt(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.createReceiptFromPurchase(id, { userId, profileId });
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async getReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.getReceiptById(receiptId, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async scanReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { productId, barcode, sku } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.scanToReceipt(
        receiptId,
        { productId, barcode, sku },
        { profileId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async completeReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { warehouseId } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const data = await purchasesService.completeReceipt(receiptId, { profileId, userId, warehouseId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async resolveExtras(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { action, supplierId, note, warehouseId } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const data = await purchasesService.resolveReceiptExtras(
        receiptId,
        { action, supplierId, note, warehouseId },
        { profileId, userId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async deleteReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.deleteReceipt(receiptId, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async deletePurchase(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.deletePurchase(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new PurchasesController();

