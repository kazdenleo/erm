/**
 * Supplier Stocks Controller
 * Контроллер для работы с остатками поставщиков.
 */

import supplierStocksService from '../services/supplierStocks.service.js';

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
}

const supplierStocksController = new SupplierStocksController();

export default supplierStocksController;


