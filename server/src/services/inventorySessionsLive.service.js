/**
 * Общая «живая» инвентаризация для нескольких устройств / сканеров (в памяти процесса).
 */
import crypto from 'crypto';
import repositoryFactory from '../config/repository-factory.js';
import inventorySessionsService from './inventorySessions.service.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function makeId() {
  return crypto.randomBytes(9).toString('base64url');
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

class InventorySessionsLiveService {
  constructor() {
    this._sessions = new Map();
    this.productsRepo = repositoryFactory.getProductsRepository();
  }

  _cleanupExpired() {
    const t = nowMs();
    for (const [id, s] of this._sessions.entries()) {
      if (!s || !s.expiresAt || s.expiresAt <= t) this._sessions.delete(id);
    }
  }

  _getSessionStrict(sessionId) {
    this._cleanupExpired();
    const sid = String(sessionId || '').trim();
    if (!sid) {
      const err = new Error('Некорректный ID сессии');
      err.statusCode = 400;
      throw err;
    }
    const s = this._sessions.get(sid);
    if (!s) {
      const err = new Error('Сессия инвентаризации не найдена или истекла');
      err.statusCode = 404;
      throw err;
    }
    return s;
  }

  _touch(s) {
    const t = nowMs();
    s.updatedAt = t;
    s.expiresAt = t + SESSION_TTL_MS;
  }

  _touchUserScan(row, userId) {
    const uid =
      userId != null && userId !== '' && Number.isFinite(Number(userId)) ? String(Number(userId)) : null;
    if (!uid || !row) return;
    if (!row.scanAtByUser || typeof row.scanAtByUser !== 'object') {
      row.scanAtByUser = {};
    }
    row.scanAtByUser[uid] = nowMs();
  }

  _serialize(s, { sortUserId = null } = {}) {
    const sortUid =
      sortUserId != null && sortUserId !== '' && Number.isFinite(Number(sortUserId))
        ? String(Number(sortUserId))
        : null;
    const items = [];
    for (const row of s.items.values()) {
      const out = { ...row };
      if (out.scanAtByUser && typeof out.scanAtByUser === 'object') {
        out.scanAtByUser = { ...out.scanAtByUser };
      }
      items.push(out);
    }
    items.sort((a, b) => {
      if (sortUid) {
        const ta = Number(a.scanAtByUser?.[sortUid]) || 0;
        const tb = Number(b.scanAtByUser?.[sortUid]) || 0;
        if (tb !== ta) return tb - ta;
      }
      return String(a.sku || '').localeCompare(String(b.sku || ''), 'ru', { numeric: true });
    });
    return {
      sessionId: s.id,
      warehouseId: s.warehouseId,
      ownerUserId: s.ownerUserId ?? null,
      editingSessionId: s.editingSessionId ?? null,
      zeroUnlisted: s.zeroUnlisted !== false,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      items,
      itemsCount: items.length,
    };
  }

  _seedItems(s, itemsInput) {
    if (!Array.isArray(itemsInput)) return;
    for (const it of itemsInput) {
      const pid = Number(it?.productId ?? it?.product_id);
      if (!Number.isFinite(pid) || pid < 1) continue;
      const fact = Math.max(0, clampInt(it?.fact ?? it?.quantityAfter ?? it?.quantity_after, 0, 1000000));
      const currentRaw = it?.current ?? it?.quantity_before ?? it?.quantityBefore;
      const current =
        currentRaw != null && currentRaw !== '' && Number.isFinite(Number(currentRaw))
          ? Math.max(0, Number(currentRaw))
          : 0;
      const costRaw = it?.cost ?? it?.product_cost ?? it?.productCost;
      const cost =
        costRaw != null && costRaw !== '' && Number.isFinite(Number(costRaw)) ? Number(costRaw) : null;
      s.items.set(pid, {
        productId: pid,
        sku: it?.sku || it?.product_sku || '—',
        name: it?.name || it?.product_name || 'Без названия',
        current,
        fact,
        cost,
      });
    }
  }

  async createSession({
    warehouseId,
    ownerUserId,
    zeroUnlisted = true,
    items = null,
    editingSessionId = null,
  }) {
    const wid = warehouseId != null ? Number(warehouseId) : null;
    if (!wid || Number.isNaN(wid)) {
      const err = new Error('Укажите склад инвентаризации');
      err.statusCode = 400;
      throw err;
    }
    const ouid = ownerUserId != null && ownerUserId !== '' ? Number(ownerUserId) : null;
    if (!ouid || Number.isNaN(ouid)) {
      const err = new Error('Некорректный владелец сессии');
      err.statusCode = 400;
      throw err;
    }
    const editSidRaw = editingSessionId ?? null;
    const editSid =
      editSidRaw != null && editSidRaw !== '' && Number.isFinite(Number(editSidRaw))
        ? Number(editSidRaw)
        : null;

    const id = makeId();
    const t = nowMs();
    const s = {
      id,
      warehouseId: wid,
      ownerUserId: ouid,
      editingSessionId: editSid,
      zeroUnlisted: zeroUnlisted !== false,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + SESSION_TTL_MS,
      items: new Map(),
    };
    this._seedItems(s, items);
    this._sessions.set(id, s);
    return this._serialize(s);
  }

  getSession(sessionId, { sortUserId = null } = {}) {
    const s = this._getSessionStrict(sessionId);
    return this._serialize(s, { sortUserId });
  }

  async _resolveProduct(code) {
    const v = String(code || '').trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) {
      const byId = await this.productsRepo.findById(Number(v));
      if (byId) return byId;
    }
    return await this.productsRepo.findByBarcode(v);
  }

  async _warehouseQty(productId, warehouseId) {
    const pid = Number(productId);
    const wid = Number(warehouseId);
    if (!Number.isFinite(pid) || !Number.isFinite(wid)) return 0;
    try {
      const q = await this.productsRepo.getWarehouseFreeStock(pid, wid);
      return Math.max(0, Number(q) || 0);
    } catch {
      return 0;
    }
  }

  async addScan({ sessionId, code, quantity = 1, userId = null }) {
    const s = this._getSessionStrict(sessionId);
    const q = clampInt(quantity, 1, 1000000);
    const product = await this._resolveProduct(code);
    if (!product?.id) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }

    const pid = Number(product.id);
    const prev = s.items.get(pid);
    const current = await this._warehouseQty(pid, s.warehouseId);
    if (prev) {
      prev.fact = Math.max(0, Number(prev.fact) || 0) + q;
      prev.current = current;
      this._touchUserScan(prev, userId);
    } else {
      const row = {
        productId: pid,
        sku: product.sku || '—',
        name: product.name || 'Без названия',
        current,
        fact: q,
        cost:
          product.cost != null && product.cost !== '' && Number.isFinite(Number(product.cost))
            ? Number(product.cost)
            : null,
      };
      this._touchUserScan(row, userId);
      s.items.set(pid, row);
    }

    this._touch(s);
    return this._serialize(s, { sortUserId: userId });
  }

  async removeItem({ sessionId, productId }) {
    const s = this._getSessionStrict(sessionId);
    const pid = Number(productId);
    if (Number.isFinite(pid) && pid > 0) {
      s.items.delete(pid);
    }
    this._touch(s);
    return this._serialize(s);
  }

  async setFact({ sessionId, productId, fact }) {
    const s = this._getSessionStrict(sessionId);
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Некорректный товар');
      err.statusCode = 400;
      throw err;
    }
    const row = s.items.get(pid);
    if (!row) {
      const err = new Error('Позиция не в списке пересчёта');
      err.statusCode = 404;
      throw err;
    }
    row.fact = Math.max(0, clampInt(fact, 0, 1000000));
    this._touch(s);
    return this._serialize(s);
  }

  async complete({
    sessionId,
    userId = null,
    profileId = null,
    zeroUnlisted = null,
    note = null,
    updateSessionId = null,
  } = {}) {
    const s = this._getSessionStrict(sessionId);
    const uid = userId != null && userId !== '' ? Number(userId) : null;
    if (!uid || Number.isNaN(uid)) {
      const err = new Error('Некорректный пользователь');
      err.statusCode = 400;
      throw err;
    }
    if (s.ownerUserId != null && Number(s.ownerUserId) !== uid) {
      const err = new Error('Применить инвентаризацию может только создатель общей сессии');
      err.statusCode = 403;
      throw err;
    }

    const lines = [];
    for (const row of s.items.values()) {
      lines.push({
        productId: row.productId,
        quantityAfter: Math.max(0, Number(row.fact) || 0),
      });
    }
    if (lines.length === 0) {
      const err = new Error('Список пересчёта пуст');
      err.statusCode = 400;
      throw err;
    }

    const zeroFlag = zeroUnlisted != null ? zeroUnlisted !== false : s.zeroUnlisted !== false;
    const updateIdRaw = updateSessionId ?? s.editingSessionId ?? null;
    const updateId =
      updateIdRaw != null && updateIdRaw !== '' && Number.isFinite(Number(updateIdRaw))
        ? Number(updateIdRaw)
        : null;

    let result;
    if (updateId) {
      result = await inventorySessionsService.updateSession(updateId, lines, {
        profileId,
        zeroUnlisted: zeroFlag,
      });
    } else {
      result = await inventorySessionsService.apply(lines, {
        userId: uid,
        profileId,
        note: note || null,
        warehouseId: s.warehouseId,
        zeroUnlisted: zeroFlag,
      });
    }
    this._sessions.delete(s.id);
    return result;
  }
}

export default new InventorySessionsLiveService();
