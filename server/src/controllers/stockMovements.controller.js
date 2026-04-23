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

  async getHistory(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const { id } = req.params;
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const history = await stockMovementsService.getHistory(id, { limit, profileId: tid });
      return res.status(200).json({ ok: true, data: history });
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

