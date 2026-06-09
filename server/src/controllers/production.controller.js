/**
 * Production Controller — сборка комплектов из комплектующих.
 */

import kitProductionService from '../services/kitProduction.service.js';

class ProductionController {
  /** GET /api/production/kit-preview?kitProductId=&warehouseId= */
  async kitPreview(req, res, next) {
    try {
      const kitProductId = req.query.kitProductId ?? req.query.kit_product_id;
      const warehouseId = req.query.warehouseId ?? req.query.warehouse_id;
      const data = await kitProductionService.getKitProductionPreview(kitProductId, warehouseId);
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /** POST /api/production/assemble-kit  body: { kitProductId, warehouseId, quantity } */
  async assembleKit(req, res, next) {
    try {
      const kitProductId = req.body?.kitProductId ?? req.body?.kit_product_id;
      const warehouseId = req.body?.warehouseId ?? req.body?.warehouse_id;
      const quantity = req.body?.quantity ?? 1;
      const data = await kitProductionService.assembleKitProduction({
        kitProductId,
        warehouseId,
        quantity,
      });
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }
}

export default new ProductionController();
