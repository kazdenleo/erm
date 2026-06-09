/**
 * Stock Movements Controller
 * HTTP контроллер для журнала движений остатков
 */

import stockMovementsService from '../services/stockMovements.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

function productProfileId(product) {
  const raw = product?.profile_id ?? product?.profileId ?? null;
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) ? n : null;
}

class StockMovementsController {
  async applyChange(req, res, next) {
    try {
      const { id } = req.params;
      const { delta, type, reason, meta } = req.body || {};

      if (delta == null || Number.isNaN(Number(delta))) {
        return res.status(400).json({ ok: false, message: 'delta (изменение остатка) обязательно' });
      }
      if (!type || typeof type !== 'string') {
        return res.status(400).json({ ok: false, message: 'type (тип операции) обязателен' });
      }

      const typeNorm = String(type).trim().toLowerCase();
      if (typeNorm === 'manual') {
        const tid = tenantListProfileId(req);
        if (tid === TENANT_LIST_EMPTY) {
          return res.status(403).json({ ok: false, message: 'Нет доступа' });
        }
        await stockMovementsService.assertManualWarehouseStockEditAllowed(tid);

        const metaObj = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
        const whRaw = metaObj.warehouse_id ?? metaObj.warehouseId;
        if (whRaw == null || String(whRaw).trim() === '') {
          return res.status(400).json({ ok: false, message: 'warehouse_id в meta обязателен' });
        }

        const product = await stockMovementsService.productsRepository.findById(id);
        if (!product) {
          return res.status(404).json({ ok: false, message: 'Товар не найден' });
        }
        if (tid != null) {
          const pPid = productProfileId(product);
          if (pPid == null || String(pPid) !== String(tid)) {
            return res.status(403).json({ ok: false, message: 'Нет доступа к товару' });
          }
        }
        const pt = String(product.product_type ?? product.productType ?? '').trim().toLowerCase();
        if (pt === 'kit') {
          return res.status(400).json({
            ok: false,
            message: 'Для комплектов наличие задаётся через комплектующие, не вручную'
          });
        }
      }

      const result = await stockMovementsService.applyChange(id, {
        delta: Number(delta),
        type: typeNorm,
        reason: reason || null,
        meta: meta || null
      });

      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getWarehouseStock(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: { quantity: 0 } });
      }
      const { id } = req.params;
      const warehouseId = req.query.warehouseId ?? req.query.warehouse_id;
      if (warehouseId == null || String(warehouseId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'warehouseId обязателен' });
      }
      const whId = await stockMovementsService.productsRepository.resolveOwnWarehouseId(warehouseId);
      if (!whId) {
        return res.status(400).json({ ok: false, message: 'Склад не найден' });
      }
      const quantity = await stockMovementsService.productsRepository.getWarehouseFreeStock(id, whId);
      return res.status(200).json({ ok: true, data: { warehouseId: whId, quantity } });
    } catch (error) {
      next(error);
    }
  }

  async getHistory(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const { id } = req.params;
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const warehouseId = req.query.warehouseId ?? req.query.warehouse_id ?? null;
      const history = await stockMovementsService.getHistory(id, {
        limit,
        profileId: tid,
        warehouseId
      });
      const movements = Array.isArray(history) ? history : history?.movements ?? [];
      const netReserved =
        history?.netReserved != null ? Number(history.netReserved) : null;
      return res.status(200).json({ ok: true, data: movements, netReserved });
    } catch (error) {
      next(error);
    }
  }

  /** Заказы с ненулевым резервом по товару (для истории остатков). */
  async getReservedOrders(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const { id } = req.params;
      const warehouseRaw = req.query.warehouseId ?? req.query.warehouse_id ?? null;
      const whFilter = await stockMovementsService.resolveWarehouseFilter(warehouseRaw);

      await stockMovementsService
        .releaseUnattributedJournalReserve(id, {
          profileId: tid,
          warehouseId: whFilter
        })
        .catch(() => {});

      await stockMovementsService._reconcileKitReserveForProductModal(id).catch(() => {});

      const rows = await stockMovementsService.listReservedOrdersForProduct(id, {
        profileId: tid,
        warehouseId: whFilter
      });
      const fboSupplies = await stockMovementsService.listFboReservedSuppliesForProduct(id, {
        profileId: tid
      });
      const summary = await stockMovementsService.getReserveSummaryForProduct(id, {
        profileId: tid,
        warehouseId: whFilter
      });
      return res.status(200).json({ ok: true, data: rows, fboSupplies, summary });
    } catch (error) {
      next(error);
    }
  }

  /** Снять резерв по одному заказу (модалка остатков, в т.ч. отменён/отгружен). */
  async releaseOrderReserve(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: { releasedProductLines: 0 } });
      }
      const { id } = req.params;
      const orderDbId = req.body?.orderDbId ?? req.body?.order_db_id;
      if (orderDbId == null || orderDbId === '') {
        return res.status(400).json({ ok: false, message: 'orderDbId обязателен' });
      }
      const summary = await stockMovementsService.releaseOrderReserveForProduct(id, orderDbId, {
        profileId: tid
      });
      return res.status(200).json({ ok: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  /** Снять лишний резерв в журнале (без заказов и FBO). */
  async releaseOrphanReserve(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: { releasedProductLines: 0, releasedQty: 0, skipped: true } });
      }
      const { id } = req.params;
      const warehouseRaw =
        req.body?.warehouseId ?? req.body?.warehouse_id ?? req.query?.warehouseId ?? req.query?.warehouse_id ?? null;
      const whFilter = await stockMovementsService.resolveWarehouseFilter(warehouseRaw);
      const summary = await stockMovementsService.releaseUnattributedJournalReserve(id, {
        profileId: tid,
        warehouseId: whFilter
      });
      if (summary.skipped && (summary.releasedProductLines || 0) === 0 && (summary.releasedQty || 0) === 0) {
        const error = new Error(
          'Не удалось снять резерв: по товару не найдено записей в журнале для снятия'
        );
        error.statusCode = 400;
        throw error;
      }
      return res.status(200).json({ ok: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  /** Снять весь резерв по товару (все заказы из модалки остатков). */
  async releaseAllReserves(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: { releasedOrders: 0, releasedProductLines: 0, ordersChecked: 0 } });
      }
      const { id } = req.params;
      const warehouseRaw =
        req.body?.warehouseId ?? req.body?.warehouse_id ?? req.query?.warehouseId ?? req.query?.warehouse_id ?? null;
      const whFilter = await stockMovementsService.resolveWarehouseFilter(warehouseRaw);
      const summary = await stockMovementsService.releaseAllReservesForProduct(id, {
        profileId: tid,
        warehouseId: whFilter
      });
      return res.status(200).json({ ok: true, data: summary });
    } catch (error) {
      next(error);
    }
  }

  async transfer(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
      }
      const { id } = req.params;
      const { fromWarehouseId, toWarehouseId, quantity, reason, meta } = req.body || {};
      if (fromWarehouseId == null || String(fromWarehouseId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'fromWarehouseId обязателен' });
      }
      if (toWarehouseId == null || String(toWarehouseId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'toWarehouseId обязателен' });
      }
      if (quantity == null || Number.isNaN(Number(quantity))) {
        return res.status(400).json({ ok: false, message: 'quantity обязателен' });
      }
      const result = await stockMovementsService.transfer(id, {
        fromWarehouseId,
        toWarehouseId,
        quantity: Number(quantity),
        reason: reason || null,
        meta: meta || null,
        profileId: req.user?.profileId ?? null,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /** Сброс истории остатков и установка текущих значений (администратор аккаунта). */
  async resetStockHistory(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Нет доступа' });
      }
      const { id } = req.params;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const warehouseId = body.warehouseId ?? body.warehouse_id;
      if (warehouseId == null || String(warehouseId).trim() === '') {
        return res.status(400).json({ ok: false, message: 'warehouseId обязателен' });
      }

      const product = await stockMovementsService.productsRepository.findById(id);
      if (!product) {
        return res.status(404).json({ ok: false, message: 'Товар не найден' });
      }
      const pPid = productProfileId(product);
      if (pPid == null || String(pPid) !== String(tid)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к товару' });
      }

      const result = await stockMovementsService.resetProductStockHistoryAndSetValues(id, {
        warehouseId,
        incoming: body.incoming,
        onHand: body.onHand ?? body.on_hand ?? body.quantity,
        reserved: body.reserved,
        profileId: tid,
        reason: body.reason || null,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export default new StockMovementsController();

