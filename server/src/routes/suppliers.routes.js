/**
 * Suppliers Routes
 * Маршруты для работы с поставщиками
 */

import express from 'express';
import suppliersController from '../controllers/suppliers.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import {
  validateCreateSupplier,
  validateUpdateSupplier,
  validateSupplierId,
} from '../validators/supplierValidator.js';

const router = express.Router();

// Получить всех поставщиков
router.get('/', wrapAsync(suppliersController.getAll.bind(suppliersController)));

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


