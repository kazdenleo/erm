/**
 * Warehouses Routes
 * Маршруты для работы со складами
 */

import express from 'express';
import warehousesController from '../controllers/warehouses.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import {
  validateCreateWarehouse,
  validateUpdateWarehouse,
  validateWarehouseId,
} from '../validators/warehouseValidator.js';

const router = express.Router();

// Получить все склады
router.get('/', wrapAsync(warehousesController.getAll.bind(warehousesController)));

router.get(
  '/:id/stock-sync-exclusions',
  validateWarehouseId,
  wrapAsync(warehousesController.listStockSyncExclusions.bind(warehousesController))
);

router.post(
  '/:id/stock-sync-exclusions',
  validateWarehouseId,
  wrapAsync(warehousesController.addStockSyncExclusion.bind(warehousesController))
);

router.delete(
  '/:id/stock-sync-exclusions/:exclusionId',
  validateWarehouseId,
  wrapAsync(warehousesController.removeStockSyncExclusion.bind(warehousesController))
);

// Создать новый склад (с валидацией)
router.post(
  '/',
  validateCreateWarehouse,
  wrapAsync(warehousesController.create.bind(warehousesController))
);

// Обновить склад (с валидацией)
router.put(
  '/:id',
  validateWarehouseId,
  validateUpdateWarehouse,
  wrapAsync(warehousesController.update.bind(warehousesController))
);

// Удалить склад (с валидацией ID)
router.delete(
  '/:id',
  validateWarehouseId,
  wrapAsync(warehousesController.delete.bind(warehousesController))
);

export default router;


