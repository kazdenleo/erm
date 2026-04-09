/**
 * Warehouse Mappings Validator
 */

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
  const mp = String(marketplace || '').trim().toLowerCase();
  if (!['ozon', 'wb', 'ym'].includes(mp)) {
    return res.status(400).json({ ok: false, message: 'marketplace должен быть ozon|wb|ym' });
  }
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
  next();
}

