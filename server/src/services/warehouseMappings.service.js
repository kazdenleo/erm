/**
 * Warehouse Mappings Service
 * Привязка складов маркетплейсов к фактическим складам (own warehouses).
 */

import repositoryFactory from '../config/repository-factory.js';
import { normalizeWarehouseMappingMarketplace } from '../validators/warehouseMappingsValidator.js';
import { parseMarketplaceWarehouseId } from '../utils/marketplaceWarehouseId.js';
import { buildYandexWarehouseMapping, parseYandexWarehouseMapping } from '../utils/yandexWarehouseMapping.js';

function normalizeMarketplaceWarehouseId(marketplace, marketplaceWarehouseId) {
  const mp = normalizeWarehouseMappingMarketplace(marketplace);
  const mw = String(marketplaceWarehouseId ?? '').trim();
  if (mp === 'ozon' || mp === 'wb') {
    return parseMarketplaceWarehouseId(mw) || '';
  }
  if (mp !== 'ym') return mw;
  const parsed = parseYandexWarehouseMapping(mw);
  if (parsed.campaignId || parsed.warehouseId) {
    return buildYandexWarehouseMapping(parsed);
  }
  return mw;
}

function assertMarketplaceWarehouseId(mp, mw) {
  if (mw) return;
  const err = new Error(
    mp === 'ozon' || mp === 'wb'
      ? 'Укажите числовой ID склада маркетплейса (выберите склад из списка API, не название)'
      : 'Укажите marketplaceWarehouseId (для Яндекс.Маркет: campaignId и/или warehouseId)'
  );
  err.statusCode = 400;
  throw err;
}

class WarehouseMappingsService {
  constructor() {
    this.repo = repositoryFactory.getRepository('warehouse_mappings');
    this.warehousesRepo = repositoryFactory.getWarehousesRepository();
  }

  async list({ warehouseId = null, marketplace = null, profileId = null } = {}) {
    return await this.repo.findAll({
      ...(warehouseId != null && warehouseId !== '' ? { warehouseId } : {}),
      ...(marketplace != null && marketplace !== '' ? { marketplace } : {}),
      ...(profileId != null && profileId !== '' ? { profileId } : {}),
    });
  }

  async create({ warehouseId, marketplace, marketplaceWarehouseId, profileId = null } = {}) {
    const wid = warehouseId != null ? parseInt(warehouseId, 10) : NaN;
    if (!Number.isFinite(wid) || wid < 1) {
      const err = new Error('Некорректный warehouseId');
      err.statusCode = 400;
      throw err;
    }
    const mp = normalizeWarehouseMappingMarketplace(marketplace);
    if (!['ozon', 'wb', 'ym'].includes(mp)) {
      const err = new Error('Некорректный marketplace (ozon, wb, ym)');
      err.statusCode = 400;
      throw err;
    }
    const mw = normalizeMarketplaceWarehouseId(mp, marketplaceWarehouseId);
    assertMarketplaceWarehouseId(mp, mw);

    // Проверяем, что склад существует в этом аккаунте и является "своим"
    const w =
      profileId != null && profileId !== ''
        ? await this.warehousesRepo.findById(wid, profileId)
        : await this.warehousesRepo.findById(wid);
    if (!w || w.type !== 'warehouse' || w.supplier_id != null) {
      const err = new Error('Склад не найден или не является вашим складом (type=warehouse без поставщика)');
      err.statusCode = 400;
      throw err;
    }

    return await this.repo.create({
      warehouse_id: wid,
      marketplace: mp,
      marketplace_warehouse_id: mw,
    });
  }

  async update(id, { warehouseId, marketplace, marketplaceWarehouseId, profileId = null } = {}) {
    const mid = id != null ? parseInt(id, 10) : NaN;
    if (!Number.isFinite(mid) || mid < 1) {
      const err = new Error('Некорректный ID маппинга');
      err.statusCode = 400;
      throw err;
    }
    const existing = await this.repo.findById(mid);
    if (!existing) {
      const err = new Error('Маппинг не найден');
      err.statusCode = 404;
      throw err;
    }
    if (profileId != null && profileId !== '') {
      const owner = await this.warehousesRepo.findById(existing.warehouse_id, profileId);
      if (!owner) {
        const err = new Error('Маппинг не найден');
        err.statusCode = 404;
        throw err;
      }
    }
    const updates = {};
    if (warehouseId != null) {
      const wid = parseInt(warehouseId, 10);
      if (!Number.isFinite(wid) || wid < 1) {
        const err = new Error('Некорректный warehouseId');
        err.statusCode = 400;
        throw err;
      }
      if (profileId != null && profileId !== '') {
        const wnew = await this.warehousesRepo.findById(wid, profileId);
        if (!wnew || wnew.type !== 'warehouse' || wnew.supplier_id != null) {
          const err = new Error('Склад не найден или не является вашим складом (type=warehouse без поставщика)');
          err.statusCode = 400;
          throw err;
        }
      }
      updates.warehouse_id = wid;
    }
    if (marketplace != null) {
      const mp = normalizeWarehouseMappingMarketplace(marketplace);
      if (!['ozon', 'wb', 'ym'].includes(mp)) {
        const err = new Error('Некорректный marketplace (ozon, wb, ym)');
        err.statusCode = 400;
        throw err;
      }
      updates.marketplace = mp;
    }
    if (marketplaceWarehouseId != null) {
      const mpForMw = updates.marketplace ?? existing.marketplace;
      const mw = normalizeMarketplaceWarehouseId(mpForMw, marketplaceWarehouseId);
      assertMarketplaceWarehouseId(mpForMw, mw);
      updates.marketplace_warehouse_id = mw;
    }
    const updated = await this.repo.update(mid, updates);
    if (!updated) {
      const err = new Error('Маппинг не найден');
      err.statusCode = 404;
      throw err;
    }
    return updated;
  }

  async delete(id, { profileId = null } = {}) {
    const mid = id != null ? parseInt(id, 10) : NaN;
    if (!Number.isFinite(mid) || mid < 1) {
      const err = new Error('Некорректный ID маппинга');
      err.statusCode = 400;
      throw err;
    }
    if (profileId != null && profileId !== '') {
      const existing = await this.repo.findById(mid);
      if (!existing) {
        const err = new Error('Маппинг не найден');
        err.statusCode = 404;
        throw err;
      }
      const owner = await this.warehousesRepo.findById(existing.warehouse_id, profileId);
      if (!owner) {
        const err = new Error('Маппинг не найден');
        err.statusCode = 404;
        throw err;
      }
    }
    const ok = await this.repo.delete(mid);
    if (!ok) {
      const err = new Error('Маппинг не найден');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true };
  }
}

export default new WarehouseMappingsService();

