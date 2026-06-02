/**
 * Stock Movements Controller
 * HTTP контроллер для журнала движений остатков
 */

import stockMovementsService from '../services/stockMovements.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

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

      const result = await stockMovementsService.applyChange(id, {
        delta: Number(delta),
        type,
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
      await stockMovementsService
        .reconcileJournalReserveForProduct(id, { profileId: tid })
        .catch(() => {});
      const rows = await stockMovementsService.listReservedOrdersForProduct(id, { profileId: tid });
      const fboSupplies = await stockMovementsService.listFboReservedSuppliesForProduct(id, {
        profileId: tid
      });
      const summary = await stockMovementsService.getReserveSummaryForProduct(id, { profileId: tid });
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

  /** Снять весь резерв по товару (все заказы из модалки остатков). */
  async releaseAllReserves(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: { releasedOrders: 0, releasedProductLines: 0, ordersChecked: 0 } });
      }
      const { id } = req.params;
      const summary = await stockMovementsService.releaseAllReservesForProduct(id, { profileId: tid });
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
}

export default new StockMovementsController();

