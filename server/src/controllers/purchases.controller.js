/**
 * Purchases Controller
 * Закупки и приёмки по закупке (сканирование).
 */

import purchasesService from '../services/purchases.service.js';
import purchasesImportService from '../services/purchasesImport.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

class PurchasesController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const status = req.query.status != null && String(req.query.status).trim() !== '' ? String(req.query.status).trim() : null;
      const activeOnly =
        req.query.activeOnly === '1' ||
        req.query.activeOnly === 'true' ||
        (req.query.includeArchived !== '1' &&
          req.query.includeArchived !== 'true' &&
          status == null);
      const profileId = tid;
      const data = await purchasesService.list({ profileId, limit, status, activeOnly });
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

  /**
   * POST /api/purchases/import/excel
   * multipart: file, supplierId, organizationId, warehouseId
   */
  /**
   * POST /api/purchases/import/excel/preview
   * multipart: file, supplierId — разбор без создания закупки (допускаются не найденные артикулы).
   */
  async previewExcelFromExcel(req, res, next) {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Загрузите файл Excel (.xlsx)' });
      }
      const supplierId = req.body?.supplierId ?? req.body?.supplier_id;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesImportService.previewExcelBuffer(req.file.buffer, {
        supplierId,
        profileId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        });
      }
      next(e);
    }
  }

  async importFromExcel(req, res, next) {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Загрузите файл Excel (.xlsx)' });
      }
      const supplierId = req.body?.supplierId ?? req.body?.supplier_id;
      const organizationId = req.body?.organizationId ?? req.body?.organization_id;
      const warehouseId = req.body?.warehouseId ?? req.body?.warehouse_id;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesImportService.importExcelAndCreate(req.file.buffer, {
        supplierId,
        organizationId,
        warehouseId,
        profileId,
        userId,
      });
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          ...(e.details ? { details: e.details } : {}),
        });
      }
      next(e);
    }
  }

  /**
   * POST /api/purchases/procure-from-orders
   * Закупка + перевод заказов в «В закупке» одним запросом (без 504 nginx).
   */
  async procureFromOrders(req, res, next) {
    try {
      const body = req.body || {};
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.procureFromOrders(
        {
          procurementItems: body.procurementItems ?? body.orderItems ?? [],
          existingPurchaseId: body.existingPurchaseId ?? body.purchaseId ?? null,
          supplierId: body.supplierId,
          organizationId: body.organizationId,
          warehouseId: body.warehouseId,
          items: body.items,
          note: body.note,
        },
        { userId, profileId }
      );
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
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

  async createExpectedReceipt(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.createOrGetExpectedReceipt(id, { userId, profileId });
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async saveExpectedReceiptItems(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { items } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.saveExpectedReceiptItems(receiptId, { items }, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async applyExpectedReceipt(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.applyExpectedReceiptToPurchase(id, { userId, profileId });
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
      const { forceNew } = req.body || {};
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.createReceiptFromPurchase(id, {
        userId,
        profileId,
        forceNew,
      });
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

  async updateReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { note } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const data = await purchasesService.updatePurchaseReceipt(receiptId, { note, profileId });
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
      const { productId, barcode, sku, scannerId } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const data = await purchasesService.scanToReceipt(
        receiptId,
        { productId, barcode, sku, scannerId: scannerId ?? (req.get('x-scanner-id') || req.get('X-Scanner-Id') || null) },
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

  async setReceiptItemQuantity(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { productId, quantity, scannerId } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const effectiveScannerId =
        scannerId ?? (req.get('x-scanner-id') || req.get('X-Scanner-Id') || null);
      const userId = req.user?.id ?? null;
      const data = await purchasesService.setReceiptItemQuantity(
        receiptId,
        { productId, quantity, scannerId: effectiveScannerId },
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

  async addReceiptQuantity(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { productId, barcode, sku, quantity, scannerId } = req.body || {};
      const profileId = req.user?.profileId ?? null;
      const effectiveScannerId =
        scannerId ?? (req.get('x-scanner-id') || req.get('X-Scanner-Id') || null);
      const userId = req.user?.id ?? null;
      const data = await purchasesService.addQuantityToReceipt(
        receiptId,
        { productId, barcode, sku, quantity, scannerId: effectiveScannerId },
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

  async inviteToReceipt(req, res, next) {
    try {
      const { receiptId } = req.params;
      const { userId: targetUserIdRaw } = req.body || {};
      const targetUserId = targetUserIdRaw != null && targetUserIdRaw !== '' ? Number(targetUserIdRaw) : null;
      if (!targetUserId || Number.isNaN(targetUserId)) {
        return res.status(400).json({ ok: false, message: 'Укажите пользователя' });
      }
      const me = req.user?.id != null ? Number(req.user.id) : null;
      if (me != null && !Number.isNaN(me) && me === targetUserId) {
        return res.status(400).json({ ok: false, message: 'Нельзя пригласить самого себя' });
      }
      const profileId = req.user?.profileId ?? null;
      const row = await purchasesService.getPurchaseReceiptForInvite(receiptId, { profileId });
      const creatorId =
        row.created_by_user_id != null && row.created_by_user_id !== ''
          ? Number(row.created_by_user_id)
          : null;
      if (creatorId != null && Number.isFinite(creatorId) && me != null && Number.isFinite(me) && me !== creatorId) {
        return res.status(403).json({ ok: false, message: 'Приглашать может только создатель приёмки' });
      }
      const rid = Number(row.id);
      const url = `/stock-levels/purchases?purchase_receipt=${encodeURIComponent(String(rid))}`;
      const from = req.user?.fullName || req.user?.email || 'Пользователь';
      await addRuntimeNotification({
        type: 'purchase_receipt_invite',
        severity: 'info',
        title: 'Приглашение в приёмку по закупке',
        message: `${from} приглашает вас в совместную приёмку №${rid} (закупка №${row.purchase_id}). Нажмите «Открыть приёмку» в уведомлении.`,
        meta: {
          target_user_id: targetUserId,
          url,
          receipt_id: rid,
          purchase_id: row.purchase_id ?? null,
        },
      });
      return res.status(200).json({ ok: true, data: { ok: true, url, receiptId: rid } });
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

