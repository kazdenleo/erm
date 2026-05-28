/**
 * Warehouse Receipts Sessions Service
 * Общая "живая" приёмка для нескольких устройств (без закупки).
 *
 * Важно: хранится в памяти процесса. Подходит для локального использования и single-instance.
 */
import crypto from 'crypto';
import repositoryFactory from '../config/repository-factory.js';
import warehouseReceiptsService from './warehouseReceipts.service.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function nowMs() {
  return Date.now();
}

function makeId() {
  // короткий, но достаточно случайный id для ссылок
  return crypto.randomBytes(9).toString('base64url');
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

class WarehouseReceiptsSessionsService {
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
      const err = new Error('Сессия приёмки не найдена или истекла');
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

  _serialize(s) {
    const items = [];
    for (const row of s.items.values()) {
      items.push({ ...row });
    }
    items.sort((a, b) => String(a.sku || '').localeCompare(String(b.sku || ''), 'ru', { numeric: true }));
    return {
      sessionId: s.id,
      warehouseId: s.warehouseId,
      ownerUserId: s.ownerUserId ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      items,
      itemsCount: items.length
    };
  }

  async createSession({ warehouseId, ownerUserId }) {
    const wid = warehouseId != null ? Number(warehouseId) : null;
    if (!wid || Number.isNaN(wid)) {
      const err = new Error('Укажите склад приёмки');
      err.statusCode = 400;
      throw err;
    }
    const ouid = ownerUserId != null && ownerUserId !== '' ? Number(ownerUserId) : null;
    if (!ouid || Number.isNaN(ouid)) {
      const err = new Error('Некорректный владелец сессии');
      err.statusCode = 400;
      throw err;
    }
    const id = makeId();
    const t = nowMs();
    const s = {
      id,
      warehouseId: wid,
      ownerUserId: ouid,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + SESSION_TTL_MS,
      items: new Map(), // productId -> { productId, sku, name, quantity, cost }
    };
    this._sessions.set(id, s);
    return this._serialize(s);
  }

  getSession(sessionId) {
    const s = this._getSessionStrict(sessionId);
    return this._serialize(s);
  }

  async _resolveProduct(code) {
    const v = String(code || '').trim();
    if (!v) return null;
    // Если передали числовой productId — берём напрямую
    if (/^\d+$/.test(v)) {
      const byId = await this.productsRepo.findById(Number(v));
      if (byId) return byId;
    }
    // repo уже умеет искать и по barcode, и по SKU fallback
    return await this.productsRepo.findByBarcode(v);
  }

  async addQuantity({ sessionId, code, quantity, cost = null }) {
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
    const normalizedCost =
      cost != null && cost !== '' && Number.isFinite(Number(cost)) ? Number(cost) : null;
    if (prev) {
      prev.quantity += q;
      if (normalizedCost != null) prev.cost = normalizedCost;
    } else {
      const pc = product?.cost;
      const defaultCost = pc != null && pc !== '' && Number.isFinite(Number(pc)) ? Number(pc) : null;
      s.items.set(pid, {
        productId: pid,
        sku: product.sku || '—',
        name: product.name || 'Без названия',
        quantity: q,
        cost: normalizedCost ?? defaultCost
      });
    }

    this._touch(s);
    return this._serialize(s);
  }

  async complete({ sessionId, supplierId = null, organizationId = null, userId = null }) {
    const s = this._getSessionStrict(sessionId);
    const uid = userId != null && userId !== '' ? Number(userId) : null;
    if (!uid || Number.isNaN(uid)) {
      const err = new Error('Некорректный пользователь');
      err.statusCode = 400;
      throw err;
    }
    if (s.ownerUserId != null && Number(s.ownerUserId) !== uid) {
      const err = new Error('Только создатель общей приёмки может оформить документ');
      err.statusCode = 403;
      throw err;
    }
    const lines = [];
    for (const row of s.items.values()) {
      lines.push({
        productId: row.productId,
        quantity: row.quantity,
        cost: row.cost
      });
    }
    if (lines.length === 0) {
      const err = new Error('Список пуст');
      err.statusCode = 400;
      throw err;
    }
    const result = await warehouseReceiptsService.createReceipt({
      supplierId: supplierId != null && supplierId !== '' ? Number(supplierId) : null,
      organizationId: organizationId != null && organizationId !== '' ? Number(organizationId) : null,
      warehouseId: s.warehouseId,
      lines
    });
    this._sessions.delete(s.id);
    return result;
  }
}

export default new WarehouseReceiptsSessionsService();

