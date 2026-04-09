/**
 * Integrations Routes
 * Маршруты для работы с настройками интеграций
 */

import express from 'express';
import integrationsController from '../controllers/integrations.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

// Специфичные маршруты маркетплейсов (должны быть ДО /marketplaces/:type)
// Категории Ozon
router.get('/marketplaces/ozon/categories', wrapAsync(integrationsController.getOzonCategories));
router.post('/marketplaces/ozon/categories/update', wrapAsync(integrationsController.updateOzonCategories));
// Склады Ozon
router.get('/marketplaces/ozon/warehouses', wrapAsync(integrationsController.getOzonWarehouses));
// Кампании Яндекс.Маркет (используем campaignId как "склад" для сопоставления)
router.get('/marketplaces/yandex/campaigns', wrapAsync(integrationsController.getYandexCampaigns));
// Атрибуты категории Ozon (характеристики и справочники)
router.get('/marketplaces/ozon/product-info', wrapAsync(integrationsController.getOzonProductInfo));
router.get('/marketplaces/ozon/category-attributes', wrapAsync(integrationsController.getOzonCategoryAttributes));
router.get('/marketplaces/ozon/attribute-values', wrapAsync(integrationsController.getOzonAttributeValues));
router.get('/marketplaces/ozon/attribute-values/search', wrapAsync(integrationsController.searchOzonAttributeValues));

// Категории Яндекс.Маркета
router.get('/marketplaces/yandex/categories', wrapAsync(integrationsController.getYandexCategories));
router.post('/marketplaces/yandex/categories/update', wrapAsync(integrationsController.updateYandexCategories));

// Проверка токенов маркетплейсов + уведомления
router.get('/marketplaces/:type/token-status', wrapAsync(integrationsController.getMarketplaceTokenStatus));
router.get('/notifications', wrapAsync(integrationsController.getNotifications));

// Тарифы и комиссии Wildberries
router.get('/marketplaces/wildberries/product-info', wrapAsync(integrationsController.getWildberriesProductInfo));
// Склады/офисы WB для FBS (для привязки к фактическому складу)
router.get('/marketplaces/wildberries/offices', wrapAsync(integrationsController.getWildberriesOffices));
router.get('/marketplaces/wildberries/warehouses', wrapAsync(integrationsController.getWildberriesSellerWarehouses));
router.get('/marketplaces/wildberries/tariffs', (req, res, next) =>
  integrationsController.getWildberriesTariffs(req, res, next)
);
router.post('/marketplaces/wildberries/tariffs/update', (req, res, next) =>
  integrationsController.updateWildberriesTariffs(req, res, next)
);
router.get('/marketplaces/wildberries/commissions', (req, res, next) =>
  integrationsController.getWildberriesCommissions(req, res, next)
);
router.post('/marketplaces/wildberries/commissions/update', (req, res, next) =>
  integrationsController.updateWildberriesCommissions(req, res, next)
);
router.get('/marketplaces/wildberries/categories', (req, res, next) =>
  integrationsController.getWildberriesCategories(req, res, next)
);

// Общие маршруты маркетплейсов
router.get('/marketplaces/:type', (req, res, next) =>
  integrationsController.getMarketplace(req, res, next)
);
router.put('/marketplaces/:type', (req, res, next) =>
  integrationsController.saveMarketplace(req, res, next)
);

// Поставщики
router.get('/suppliers/:type', (req, res, next) =>
  integrationsController.getSupplier(req, res, next)
);
router.put('/suppliers/:type', (req, res, next) =>
  integrationsController.saveSupplier(req, res, next)
);

// Все настройки (только конфигурации)
router.get('/all', (req, res, next) =>
  integrationsController.getAll(req, res, next)
);

// Все интеграции (полный список с метаданными)
router.get('/', (req, res, next) =>
  integrationsController.getAllIntegrations(req, res, next)
);

export default router;

