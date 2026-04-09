/**
 * Buyout Rate Routes
 * Маршруты для синхронизации процента выкупа товаров
 */

import express from 'express';
import buyoutRateController from '../controllers/buyout-rate.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

// Синхронизировать процент выкупа для одного товара
router.get('/sync/:productId', wrapAsync(buyoutRateController.syncForProduct.bind(buyoutRateController)));

// Синхронизировать процент выкупа для всех товаров
router.post('/sync/all', wrapAsync(buyoutRateController.syncForAll.bind(buyoutRateController)));

export default router;

