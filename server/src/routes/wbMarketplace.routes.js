/**
 * WB Marketplace Routes
 * Роуты для работы с категориями и комиссиями Wildberries
 */

import express from 'express';
import wbMarketplaceService from '../services/wbMarketplace.service.js';
import schedulerService from '../services/scheduler.service.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * POST /api/wb-marketplace/update
 * Ручной запуск обновления категорий и комиссий WB
 */
router.post('/update', wrapAsync(async (req, res) => {
  const result = await wbMarketplaceService.updateCategoriesAndCommissions();
  res.json({
    ok: true,
    message: 'WB categories and commissions updated successfully',
    data: result
  });
}));

/**
 * GET /api/wb-marketplace/commissions
 * Получить все комиссии WB
 */
router.get('/commissions', wrapAsync(async (req, res) => {
  const commissions = await wbMarketplaceService.getAllCommissions();
  res.json({
    ok: true,
    data: commissions
  });
}));

/**
 * GET /api/wb-marketplace/commissions/:categoryId
 * Получить комиссию по ID категории
 */
router.get('/commissions/:categoryId', wrapAsync(async (req, res) => {
  const { categoryId } = req.params;
  const commission = await wbMarketplaceService.getCommissionByCategoryId(parseInt(categoryId));
  
  if (!commission) {
    return res.status(404).json({
      ok: false,
      message: 'Commission not found'
    });
  }
  
  res.json({
    ok: true,
    data: commission
  });
}));

/**
 * GET /api/wb-marketplace/scheduler/status
 * Получить статус планировщика
 */
router.get('/scheduler/status', wrapAsync(async (req, res) => {
  const status = schedulerService.getStatus();
  res.json({
    ok: true,
    data: status
  });
}));

export default router;

