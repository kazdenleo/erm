/**
 * Suppliers Routes
 * Маршруты для работы с поставщиками
 */

import express from 'express';
import suppliersController from '../controllers/suppliers.controller.js';
import settlementsController from '../controllers/supplierSettlements.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import {
  validateCreateSupplier,
  validateUpdateSupplier,
  validateSupplierId,
} from '../validators/supplierValidator.js';

const router = express.Router();

const requireSettlementSupplier = wrapAsync(settlementsController.requireSupplier.bind(settlementsController));

// Получить всех поставщиков
router.get('/', wrapAsync(suppliersController.getAll.bind(suppliersController)));

// Взаиморасчёты (до '/:id', чтобы 'settlements' не принимался за ID)
router.get(
  '/settlements/balances',
  requireAuth,
  wrapAsync(settlementsController.listBalances.bind(settlementsController))
);
router.get(
  '/:id/settlements',
  requireAuth,
  requireSettlementSupplier,
  wrapAsync(settlementsController.getLedger.bind(settlementsController))
);
router.post(
  '/:id/settlements',
  requireAuth,
  requireSettlementSupplier,
  wrapAsync(settlementsController.createEntry.bind(settlementsController))
);
router.delete(
  '/:id/settlements/:entryId',
  requireAuth,
  requireSettlementSupplier,
  wrapAsync(settlementsController.deleteEntry.bind(settlementsController))
);

// Получить поставщика по ID (с валидацией)
router.get(
  '/:id',
  validateSupplierId,
  wrapAsync(suppliersController.getById.bind(suppliersController))
);

// Создать нового поставщика (с валидацией)
router.post(
  '/',
  validateCreateSupplier,
  wrapAsync(suppliersController.create.bind(suppliersController))
);

// Обновить поставщика (с валидацией)
router.put(
  '/:id',
  validateSupplierId,
  validateUpdateSupplier,
  wrapAsync(suppliersController.update.bind(suppliersController))
);

// Удалить поставщика (с валидацией ID)
router.delete(
  '/:id',
  validateSupplierId,
  wrapAsync(suppliersController.delete.bind(suppliersController))
);

export default router;


