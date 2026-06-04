/**
 * Warehouse Mappings Validator
 */

export function normalizeWarehouseMappingMarketplace(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'wildberries' || v === 'wb') return 'wb';
  if (v === 'yandex' || v === 'ym') return 'ym';
  if (v === 'ozon') return 'ozon';
  return v;
}

export function validateWarehouseMappingId(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, message: 'Некорректный ID маппинга' });
  }
  next();
}

export function validateCreateWarehouseMapping(req, res, next) {
  const warehouseId = req.body.warehouseId ?? req.body.warehouse_id;
  const marketplace = req.body.marketplace;
  const marketplaceWarehouseId = req.body.marketplaceWarehouseId ?? req.body.marketplace_warehouse_id;
  if (warehouseId == null || String(warehouseId).trim() === '') {
    return res.status(400).json({ ok: false, message: 'warehouseId обязателен' });
  }
  const mp = normalizeWarehouseMappingMarketplace(marketplace);
  if (!['ozon', 'wb', 'ym'].includes(mp)) {
    return res.status(400).json({ ok: false, message: 'marketplace: ozon, wb (Wildberries) или ym (Яндекс Маркет)' });
  }
  req.body.marketplace = mp;
  if (marketplaceWarehouseId == null || String(marketplaceWarehouseId).trim() === '') {
    return res.status(400).json({ ok: false, message: 'marketplaceWarehouseId обязателен' });
  }
  next();
}

export function validateUpdateWarehouseMapping(req, res, next) {
  const { warehouseId, marketplace, marketplaceWarehouseId } = req.body || {};
  if (warehouseId == null && marketplace == null && marketplaceWarehouseId == null &&
      req.body?.warehouse_id == null && req.body?.marketplace_warehouse_id == null) {
    return res.status(400).json({ ok: false, message: 'Нет полей для обновления' });
  }
  if (marketplace != null && String(marketplace).trim() !== '') {
    const mp = normalizeWarehouseMappingMarketplace(marketplace);
    if (!['ozon', 'wb', 'ym'].includes(mp)) {
      return res.status(400).json({ ok: false, message: 'marketplace: ozon, wb или ym' });
    }
    req.body.marketplace = mp;
  }
  next();
}

