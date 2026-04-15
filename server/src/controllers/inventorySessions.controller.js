/**
 * Инвентаризация — список документов и применение пересчёта
 */

import inventorySessionsService from '../services/inventorySessions.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class InventorySessionsController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const profileId = tid;
      const list = await inventorySessionsService.list({ profileId, limit });
      return res.status(200).json({ ok: true, data: list });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      if (String(id) === 'apply') {
        return res.status(404).json({ ok: false, message: 'Инвентаризация не найдена' });
      }
      const profileId = req.user?.profileId ?? null;
      const data = await inventorySessionsService.getById(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async apply(req, res, next) {
    try {
      const lines = req.body?.lines;
      const note = req.body?.note != null ? String(req.body.note).trim().slice(0, 2000) : null;
      const warehouseId = req.body?.warehouseId ?? req.body?.warehouse_id ?? null;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const result = await inventorySessionsService.apply(lines, {
        userId,
        profileId,
        note: note || null,
        warehouseId
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      if (String(id) === 'apply') {
        return res.status(404).json({ ok: false, message: 'Инвентаризация не найдена' });
      }
      const profileId = req.user?.profileId ?? null;
      const data = await inventorySessionsService.deleteSession(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400 || e.statusCode === 403) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new InventorySessionsController();
