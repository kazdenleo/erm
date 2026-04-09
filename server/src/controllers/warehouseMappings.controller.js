/**
 * Warehouse Mappings Controller
 */

import warehouseMappingsService from '../services/warehouseMappings.service.js';

class WarehouseMappingsController {
  async list(req, res) {
    const warehouseId = req.query.warehouseId ?? null;
    const marketplace = req.query.marketplace ?? null;
    const data = await warehouseMappingsService.list({ warehouseId, marketplace });
    return res.status(200).json({ ok: true, data });
  }

  async create(req, res) {
    const data = await warehouseMappingsService.create({
      warehouseId: req.body.warehouseId ?? req.body.warehouse_id,
      marketplace: req.body.marketplace,
      marketplaceWarehouseId: req.body.marketplaceWarehouseId ?? req.body.marketplace_warehouse_id,
    });
    return res.status(200).json({ ok: true, data });
  }

  async update(req, res) {
    const data = await warehouseMappingsService.update(req.params.id, {
      warehouseId: req.body.warehouseId ?? req.body.warehouse_id,
      marketplace: req.body.marketplace,
      marketplaceWarehouseId: req.body.marketplaceWarehouseId ?? req.body.marketplace_warehouse_id,
    });
    return res.status(200).json({ ok: true, data });
  }

  async delete(req, res) {
    const data = await warehouseMappingsService.delete(req.params.id);
    return res.status(200).json({ ok: true, data });
  }
}

export default new WarehouseMappingsController();

