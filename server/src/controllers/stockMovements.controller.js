/**
 * Stock Movements Controller
 * HTTP контроллер для журнала движений остатков
 */

import stockMovementsService from '../services/stockMovements.service.js';

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
      const { id } = req.params;
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const history = await stockMovementsService.getHistory(id, { limit, profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: history });
    } catch (error) {
      next(error);
    }
  }
}

export default new StockMovementsController();

