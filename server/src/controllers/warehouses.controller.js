/**
 * Warehouses Controller
 * HTTP контроллер для складов
 */

import warehousesService from '../services/warehouses.service.js';

class WarehousesController {
  async getAll(req, res, next) {
    try {
      const options = {};
      if (req.query.organizationId != null && req.query.organizationId !== '') options.organizationId = req.query.organizationId;
      if (req.query.type != null && req.query.type !== '') options.type = req.query.type;
      if (req.query.supplierId != null && req.query.supplierId !== '') options.supplierId = req.query.supplierId;
      if (req.user?.profileId != null && req.user.profileId !== '') options.profileId = req.user.profileId;
      const warehouses = await warehousesService.getAll(options);
      console.log('[WarehousesController] getAll - warehouses count:', warehouses.length);
      if (warehouses.length > 0) {
        const firstWarehouse = warehouses[0];
        console.log('[WarehousesController] First warehouse sample:', {
          id: firstWarehouse.id,
          type: firstWarehouse.type,
          wbWarehouseName: firstWarehouse.wbWarehouseName
        });
      }
      return res.status(200).json({ ok: true, data: warehouses });
    } catch (error) {
      next(error);
    }
  }

  async create(req, res, next) {
    try {
      const warehouse = await warehousesService.create(req.body, { profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: warehouse });
    } catch (error) {
      next(error);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      console.log('[WarehousesController] ========== Update Request ==========');
      console.log('[WarehousesController] Update request for id:', id);
      console.log('[WarehousesController] Update body:', JSON.stringify(req.body, null, 2));
      console.log('[WarehousesController] req.body keys:', Object.keys(req.body));
      console.log('[WarehousesController] req.body.wbWarehouseName:', req.body.wbWarehouseName);
      console.log('[WarehousesController] req.body.wbWarehouseName type:', typeof req.body.wbWarehouseName);
      console.log('[WarehousesController] req.body.hasOwnProperty("wbWarehouseName"):', req.body.hasOwnProperty('wbWarehouseName'));
      console.log('[WarehousesController] =====================================');
      const warehouse = await warehousesService.update(id, req.body, { profileId: req.user?.profileId ?? null });
      console.log('[WarehousesController] Updated warehouse:', JSON.stringify(warehouse, null, 2));
      console.log('[WarehousesController] Updated warehouse wbWarehouseName:', warehouse?.wbWarehouseName);
      return res.status(200).json({ ok: true, data: warehouse });
    } catch (error) {
      next(error);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const warehouse = await warehousesService.delete(id, { profileId: req.user?.profileId ?? null });
      return res.status(200).json({ ok: true, data: warehouse });
    } catch (error) {
      next(error);
    }
  }
}

export default new WarehousesController();


