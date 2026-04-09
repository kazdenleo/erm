/**
 * Assembly Routes
 * Маршруты для сборки заказов (поиск по штрихкоду)
 */

import express from 'express';
import assemblyController from '../controllers/assembly.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Найти первый заказ на сборке по штрихкоду товара
router.get(
  '/find-by-barcode',
  wrapAsync(assemblyController.findOrderByBarcode.bind(assemblyController))
);

// Отметить заказ как собранный (убрать из списка сборки) — фиксируем пользователя и время
router.post(
  '/mark-collected',
  requireAuth,
  wrapAsync(assemblyController.markCollected.bind(assemblyController))
);

export default router;
