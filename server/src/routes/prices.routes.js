/**
 * Prices Routes
 * Маршруты для расчета цен на маркетплейсах
 */

import express from 'express';
import pricesController from '../controllers/prices.controller.js';

const router = express.Router();

// Получить расчет цен для Ozon
router.get('/ozon', (req, res, next) => pricesController.getOzonPrices(req, res, next));

// Получить список акций Ozon
router.get('/actions/ozon', (req, res, next) => pricesController.getOzonActions(req, res, next));
// Товары по акции Ozon (из кэша, обновляется при ежедневном обновлении)
router.get('/actions/ozon/:actionId/products', (req, res, next) => pricesController.getOzonActionProducts(req, res, next));
// Товары, доступные к добавлению в акцию Ozon (запрос к API)
router.get('/actions/ozon/:actionId/candidates', (req, res, next) => pricesController.getOzonActionCandidates(req, res, next));

// Список акций Wildberries (календарь акций + детали)
router.get('/actions/wb', (req, res, next) => pricesController.getWBActions(req, res, next));
// Детали одной акции WB (GET .../promotions/details?promotionIDs=id)
router.get('/actions/wb/:promotionId/details', (req, res, next) => pricesController.getWBPromotionDetails(req, res, next));
// Товары по акции WB: участвующие (inAction=true) или доступные (inAction=false)
router.get('/actions/wb/:promotionId/nomenclatures', (req, res, next) => pricesController.getWBPromotionNomenclatures(req, res, next));

// Получить расчет цен для Wildberries
router.get('/wb', (req, res, next) => pricesController.getWBPrices(req, res, next));

// Получить расчет цен для Yandex Market
router.get('/ym', (req, res, next) => pricesController.getYMPrices(req, res, next));

// Пересчитать все минимальные цены и сохранить в БД (фоновый запуск)
router.post('/recalculate-all', (req, res, next) => pricesController.recalculateAll(req, res, next));

// Пересчитать все мин. цены только из кэша калькулятора (фон, без API на каждый SKU)
router.post('/recalculate-all-from-cache', (req, res, next) => pricesController.recalculateAllFromCache(req, res, next));

// Обновить product_mp_calculator_cache из API (body: { marketplaces?: ['ozon','wb','ym'], limit?, delayMs? })
router.post('/sync-calculator-cache', (req, res, next) => pricesController.syncCalculatorCache(req, res, next));

// Пересчитать минимальные цены для одного товара (productId в теле: { productId: number })
router.post('/recalculate-one', (req, res, next) => pricesController.recalculateForProduct(req, res, next));

// Сохранить переданные рассчитанные цены в БД (массив { productId, ozon?, wb?, ym? })
router.post('/save-bulk', (req, res, next) => pricesController.saveBulk(req, res, next));

export default router;

