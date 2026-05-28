/**
 * Warehouse Receipts Controller
 * Оформление приёмок на склад
 */

import warehouseReceiptsService from '../services/warehouseReceipts.service.js';
import warehouseReceiptsSessionsService from '../services/warehouseReceiptsSessions.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

class WarehouseReceiptsController {
  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [], total: 0 });
      }
      const limit = req.query.limit ? Math.min(500, parseInt(req.query.limit, 10)) : 100;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const result = await warehouseReceiptsService.getList({
        limit,
        offset,
        ...(tid != null ? { profileId: tid } : {})
      });
      return res.status(200).json({ ok: true, data: result.list, total: result.total });
    } catch (error) {
      next(error);
    }
  }

  async getById(req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok: false, message: 'Некорректный ID' });
      const receipt = await warehouseReceiptsService.getByIdWithLines(id);
      if (!receipt) return res.status(404).json({ ok: false, message: 'Приёмка не найдена' });
      return res.status(200).json({ ok: true, data: receipt });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const { documentType, organizationId, supplierId, lines, warehouseId, warehouse_id } = req.body || {};
      const whRaw = warehouseId ?? warehouse_id ?? null;
      const linesArr = Array.isArray(lines) ? lines : [];
      if (documentType === 'return') {
        const result = await warehouseReceiptsService.createReturn({
          organizationId: organizationId || null,
          supplierId: supplierId || null,
          warehouseId: whRaw,
          lines: linesArr
        });
        return res.status(200).json({ ok: true, data: result });
      }
      if (documentType === 'customer_return') {
        const result = await warehouseReceiptsService.createCustomerReturn({
          organizationId: organizationId || null,
          warehouseId: whRaw,
          lines: linesArr
        });
        return res.status(200).json({ ok: true, data: result });
      }
      const result = await warehouseReceiptsService.createReceipt({
        organizationId: organizationId || null,
        supplierId: supplierId || null,
        warehouseId: whRaw,
        lines: linesArr
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async createSession(req, res, next) {
    try {
      const { warehouseId, warehouse_id } = req.body || {};
      const wh = warehouseId ?? warehouse_id ?? null;
      const ownerUserId = req.user?.id ?? null;
      const data = await warehouseReceiptsSessionsService.createSession({ warehouseId: wh, ownerUserId });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSession(req, res, next) {
    try {
      const { id } = req.params;
      const data = warehouseReceiptsSessionsService.getSession(id);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async addSessionQuantity(req, res, next) {
    try {
      const { id } = req.params;
      const { code, barcode, sku, quantity, cost } = req.body || {};
      const c = code ?? barcode ?? sku ?? null;
      const data = await warehouseReceiptsSessionsService.addQuantity({
        sessionId: id,
        code: c,
        quantity,
        cost: cost ?? null
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async completeSession(req, res, next) {
    try {
      const { id } = req.params;
      const { supplierId, organizationId } = req.body || {};
      const data = await warehouseReceiptsSessionsService.complete({
        sessionId: id,
        supplierId: supplierId ?? null,
        organizationId: organizationId ?? null,
        userId: req.user?.id ?? null
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  async inviteToSession(req, res, next) {
    try {
      const { id } = req.params;
      const { userId } = req.body || {};
      const targetUserId = userId != null && userId !== '' ? Number(userId) : null;
      if (!targetUserId || Number.isNaN(targetUserId)) {
        return res.status(400).json({ ok: false, message: 'Укажите пользователя' });
      }
      const me = req.user?.id != null ? Number(req.user.id) : null;
      if (me != null && !Number.isNaN(me) && me === targetUserId) {
        return res.status(400).json({ ok: false, message: 'Нельзя пригласить самого себя' });
      }
      const session = warehouseReceiptsSessionsService.getSession(id);
      if (session?.ownerUserId != null && me != null && Number(session.ownerUserId) !== Number(me)) {
        return res.status(403).json({ ok: false, message: 'Приглашать может только создатель общей приёмки' });
      }
      const sid = session?.sessionId ?? id;
      const url = `/stock-levels/warehouse?op=receipts_list&session=${encodeURIComponent(String(sid))}`;
      const from = req.user?.fullName || req.user?.email || 'Пользователь';
      await addRuntimeNotification({
        type: 'receipt_session_invite',
        severity: 'info',
        title: 'Приглашение в общую приёмку',
        message: `${from} приглашает вас в общую приёмку. Нажмите «Открыть» или перейдите по ссылке: ${url}`,
        meta: {
          target_user_id: targetUserId,
          url,
          session_id: sid,
          warehouse_id: session?.warehouseId ?? null
        }
      });
      return res.status(200).json({ ok: true, data: { ok: true, url, sessionId: sid } });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok: false, message: 'Некорректный ID' });
      const result = await warehouseReceiptsService.deleteReceipt(id);
      if (!result) return res.status(404).json({ ok: false, message: 'Документ не найден' });
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export default new WarehouseReceiptsController();
