/**
 * Supplier Stocks Controller
 * Контроллер для работы с остатками поставщиков.
 */

import supplierStocksService from '../services/supplierStocks.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class SupplierStocksController {
  async getStock(req, res, next) {
    try {
      const { supplier, sku, brand, cities } = req.query;
      const result = await supplierStocksService.getSupplierStock({
        supplier,
        sku,
        cities,
        brand
      });
      // Если данных нет (null), возвращаем пустой объект вместо ошибки
      if (result === null) {
        return res.status(200).json({ ok: true, data: null });
      }
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async syncStocks(req, res, next) {
    try {
      const { products } = req.body;
      const result = await supplierStocksService.syncSupplierStocks(products);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getWarehouses(req, res, next) {
    try {
      const { supplier } = req.query;
      const result = await supplierStocksService.getSupplierWarehouses(supplier);
      return res.status(200).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/supplier-stocks/breakdown?productIds=1,2,3&mainWarehouseId=5 */
  async getBreakdown(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const raw = req.query.productIds ?? req.query.product_ids ?? '';
      const productIds = String(raw)
        .split(/[,;\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (productIds.length === 0) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const rawMain =
        req.query.mainWarehouseId ?? req.query.main_warehouse_id ?? req.query.warehouseId ?? null;
      const mainWarehouseId =
        rawMain != null && String(rawMain).trim() !== '' ? String(rawMain).trim() : null;
      const rows = await supplierStocksService.getBreakdownByProductIds(productIds, {
        mainWarehouseId,
        profileId: tid
      });
      return res.status(200).json({ ok: true, data: rows });
    } catch (error) {
      next(error);
    }
  }
}

const supplierStocksController = new SupplierStocksController();

export default supplierStocksController;


