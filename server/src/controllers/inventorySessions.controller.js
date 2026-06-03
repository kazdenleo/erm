/**
 * Инвентаризация — список документов и применение пересчёта
 */

import inventorySessionsService from '../services/inventorySessions.service.js';
import inventorySessionsLiveService from '../services/inventorySessionsLive.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

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
      const zeroUnlistedRaw = req.body?.zeroUnlisted ?? req.body?.zero_unlisted;
      const zeroUnlisted = zeroUnlistedRaw !== false;
      const userId = req.user?.id ?? null;
      const profileId = req.user?.profileId ?? null;
      const result = await inventorySessionsService.apply(lines, {
        userId,
        profileId,
        note: note || null,
        warehouseId,
        zeroUnlisted,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      if (String(id) === 'apply') {
        return res.status(404).json({ ok: false, message: 'Инвентаризация не найдена' });
      }
      const lines = req.body?.lines;
      const zeroUnlistedRaw = req.body?.zeroUnlisted ?? req.body?.zero_unlisted;
      const zeroUnlisted = zeroUnlistedRaw !== false;
      const profileId = req.user?.profileId ?? null;
      const result = await inventorySessionsService.updateSession(id, lines, {
        profileId,
        zeroUnlisted,
      });
      return res.status(200).json({ ok: true, data: result });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async createLiveSession(req, res, next) {
    try {
      const { warehouseId, warehouse_id, zeroUnlisted, zero_unlisted } = req.body || {};
      const wh = warehouseId ?? warehouse_id ?? null;
      const zeroRaw = zeroUnlisted ?? zero_unlisted;
      const data = await inventorySessionsLiveService.createSession({
        warehouseId: wh,
        ownerUserId: req.user?.id ?? null,
        zeroUnlisted: zeroRaw !== false,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async getLiveSession(req, res, next) {
    try {
      const { id } = req.params;
      const data = inventorySessionsLiveService.getSession(id);
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async liveSessionScan(req, res, next) {
    try {
      const { id } = req.params;
      const { code, barcode, sku, quantity } = req.body || {};
      const c = code ?? barcode ?? sku ?? null;
      const data = await inventorySessionsLiveService.addScan({
        sessionId: id,
        code: c,
        quantity,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async liveSessionRemoveItem(req, res, next) {
    try {
      const { id } = req.params;
      const { productId } = req.body || {};
      const data = await inventorySessionsLiveService.removeItem({
        sessionId: id,
        productId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async liveSessionSetFact(req, res, next) {
    try {
      const { id } = req.params;
      const { productId, fact } = req.body || {};
      const data = await inventorySessionsLiveService.setFact({
        sessionId: id,
        productId,
        fact,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async completeLiveSession(req, res, next) {
    try {
      const { id } = req.params;
      const { zeroUnlisted, zero_unlisted, note } = req.body || {};
      const data = await inventorySessionsLiveService.complete({
        sessionId: id,
        userId: req.user?.id ?? null,
        profileId: req.user?.profileId ?? null,
        zeroUnlisted: zeroUnlisted ?? zero_unlisted,
        note: note ?? null,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async inviteToLiveSession(req, res, next) {
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
      const session = inventorySessionsLiveService.getSession(id);
      if (session?.ownerUserId != null && me != null && Number(session.ownerUserId) !== Number(me)) {
        return res.status(403).json({ ok: false, message: 'Приглашать может только создатель общей инвентаризации' });
      }
      const sid = session?.sessionId ?? id;
      const url = `/stock-levels/warehouse?op=inventory&inv_session=${encodeURIComponent(String(sid))}`;
      const from = req.user?.fullName || req.user?.email || 'Пользователь';
      await addRuntimeNotification({
        type: 'inventory_session_invite',
        severity: 'info',
        title: 'Приглашение в общую инвентаризацию',
        message: `${from} приглашает вас в общую инвентаризацию. Нажмите «Открыть» или перейдите по ссылке: ${url}`,
        meta: {
          target_user_id: targetUserId,
          url,
          session_id: sid,
          warehouse_id: session?.warehouseId ?? null,
        },
      });
      return res.status(200).json({ ok: true, data: { ok: true, url, sessionId: sid } });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400 || e.statusCode === 403) {
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
