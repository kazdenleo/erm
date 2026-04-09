/**
 * Supplier Stocks Routes
 * Маршруты для работы с остатками и складами поставщиков.
 */

import express from 'express';
import supplierStocksController from '../controllers/supplierStocks.controller.js';

const router = express.Router();

// GET /api/supplier-stocks?supplier=&sku=&brand=&cities=
router.get('/', (req, res, next) =>
  supplierStocksController.getStock(req, res, next)
);

// POST /api/supplier-stocks/sync  (массовая синхронизация)
router.post('/sync', (req, res, next) =>
  supplierStocksController.syncStocks(req, res, next)
);

// GET /api/supplier-stocks/warehouses?supplier=...
router.get('/warehouses', (req, res, next) =>
  supplierStocksController.getWarehouses(req, res, next)
);

export default router;


