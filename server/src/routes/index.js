/**
 * Main Router
 * Главный роутер для всех API endpoints
 */

import express from 'express';
import config from '../config/index.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { optionalAuth } from '../middleware/auth.js';
import authRoutes from './auth.routes.js';
import profilesRoutes from './profiles.routes.js';
import usersRoutes from './users.routes.js';
import productsRoutes from './products.routes.js';
import warehousesRoutes from './warehouses.routes.js';
import warehouseMappingsRoutes from './warehouseMappings.routes.js';
import suppliersRoutes from './suppliers.routes.js';
import ordersController from '../controllers/orders.controller.js';
import ordersRoutes from './orders.routes.js';
import { validateOrderDetailParams, validateOrderId } from '../validators/orderValidator.js';
import supplierStocksRoutes from './supplierStocks.routes.js';
import integrationsRoutes from './integrations.routes.js';
import { categoriesRoutes } from './categories.routes.js';
import { brandsRoutes } from './brands.routes.js';
import pricesRoutes from './prices.routes.js';
import userCategoriesRoutes from './user_categories.routes.js';
import categoryMappingsRoutes from './category_mappings.routes.js';
import buyoutRateRoutes from './buyout-rate.routes.js';
import wbMarketplaceRoutes from './wbMarketplace.routes.js';
import shipmentsRoutes from './shipments.routes.js';
import assemblyRoutes from './assembly.routes.js';
import productAttributesRoutes from './product_attributes.routes.js';
import warehouseReceiptsRoutes from './warehouseReceipts.routes.js';
import purchasesRoutes from './purchases.routes.js';
import organizationsRoutes from './organizations.routes.js';
import marketplaceCabinetsRoutes from './marketplace_cabinets.routes.js';
import certificatesRoutes from './certificates.routes.js';
import inquiriesRoutes from './inquiries.routes.js';
import inventorySessionsController from '../controllers/inventorySessions.controller.js';
import stockProblemsController from '../controllers/stockProblems.controller.js';
import purchasesController from '../controllers/purchases.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Публичная конфигурация для клиентов (один билд для всех ПК: тихая печать и т.д.)
router.get('/config', (req, res) => {
  res.json({
    ok: true,
    data: {
      printHelperUrl: config.printHelperUrl || '',
    },
  });
});

// Публичные маршруты этикеток — без авторизации, чтобы Print Helper (exe) мог скачать файл по URL
router.get('/orders/:orderId/label', validateOrderId, wrapAsync(ordersController.getLabel.bind(ordersController)));
router.get('/orders/:orderId/label/print', validateOrderId, wrapAsync(ordersController.getLabelPrint.bind(ordersController)));
router.get('/orders/:orderId/label/status', validateOrderId, wrapAsync(ordersController.getLabelStatus.bind(ordersController)));

// Опциональная авторизация для всех /api (устанавливает req.user при наличии токена)
router.use(optionalAuth);

// Пока действует временный пароль — доступ только к смене пароля, /auth/me и чтение своего пользователя (кабинет)
router.use((req, res, next) => {
  if (config.auth?.disabled) return next();
  if (!req.user?.mustChangePassword) return next();
  const url = (req.originalUrl || '').split('?')[0];
  if (req.method === 'POST' && url.startsWith('/api/auth/change-password')) return next();
  if (req.method === 'GET' && url.startsWith('/api/auth/me')) return next();
  if (req.method === 'GET' && url === '/api/users/me') return next();
  return res.status(403).json({
    ok: false,
    code: 'MUST_CHANGE_PASSWORD',
    message: 'Сначала смените временный пароль в личном кабинете.',
  });
});

// Auth (логин публичный, /me — с авторизацией внутри роута)
router.use('/auth', authRoutes);
// Профили и пользователи (защищены в своих роутах)
router.use('/profiles', profilesRoutes);
router.use('/users', usersRoutes);
router.use('/inquiries', inquiriesRoutes);

// Products API
router.use('/products', (req, res, next) => {
  console.log(`[Main Router] Products route: ${req.method} ${req.path}`);
  productsRoutes(req, res, next);
});

// Warehouses API
router.use('/warehouses', warehousesRoutes);
// Привязка складов маркетплейсов к фактическим складам
router.use('/warehouse-mappings', warehouseMappingsRoutes);

// Suppliers API
router.use('/suppliers', suppliersRoutes);

// Orders API (явные маршруты до use('/orders'), чтобы PUT с :marketplace/:orderId точно находились)
router.post('/orders/manual', requireAuth, wrapAsync(ordersController.createManual.bind(ordersController)));
router.put(
  '/orders/:marketplace/:orderId/return-to-new',
  requireAuth,
  validateOrderDetailParams,
  wrapAsync(ordersController.returnToNew.bind(ordersController))
);
router.put(
  '/orders/:marketplace/:orderId/to-procurement',
  requireAuth,
  validateOrderDetailParams,
  wrapAsync(ordersController.setToProcurement.bind(ordersController))
);
router.put(
  '/orders/:marketplace/:orderId/mark-shipped',
  requireAuth,
  validateOrderDetailParams,
  wrapAsync(ordersController.markShipped.bind(ordersController))
);
router.use('/orders', ordersRoutes);
router.use('/supplier-stocks', supplierStocksRoutes);

// Integrations API (настройки маркетплейсов и поставщиков)
router.use('/integrations', integrationsRoutes);

// Categories API
router.use('/categories', categoriesRoutes);

// Brands API
router.use('/brands', brandsRoutes);

// Prices API (расчет цен для маркетплейсов)
router.use('/product/prices', pricesRoutes);

// User Categories API (пользовательские категории)
router.use('/user-categories', userCategoriesRoutes);

// Category Mappings API (сопоставление категорий с маркетплейсами)
router.use('/category-mappings', categoryMappingsRoutes);

// Buyout Rate API (синхронизация процента выкупа с маркетплейсами)
router.use('/buyout-rate', buyoutRateRoutes);

// WB Marketplace API (категории и комиссии Wildberries)
router.use('/wb-marketplace', wbMarketplaceRoutes);

// Поставки по маркетплейсам
router.use('/shipments', shipmentsRoutes);

// Сборка заказов (поиск по штрихкоду)
router.use('/assembly', assemblyRoutes);

// Атрибуты товаров (настройки → атрибуты)
router.use('/product-attributes', productAttributesRoutes);

// Сертификаты (настройки → сертификаты)
router.use('/certificates', certificatesRoutes);

// Приёмки на склад
router.use('/receipts', warehouseReceiptsRoutes);

// Закупки: DELETE на главном роутере — во вложенном Router в ряде окружений не срабатывал DELETE /:id (404).
router.delete(
  '/purchases/receipts/:receiptId',
  requireAuth,
  wrapAsync(purchasesController.deleteReceipt.bind(purchasesController))
);
router.delete(
  '/purchases/:id',
  requireAuth,
  wrapAsync(purchasesController.deletePurchase.bind(purchasesController))
);
// Закупки (ожидание) и приёмки по закупкам — остальные методы
router.use('/purchases', purchasesRoutes);

// Проблемы остатков: какие заказы без покрытия (FIFO по резервам)
router.get(
  '/stock-problems/orders',
  requireAuth,
  wrapAsync(stockProblemsController.getProblemOrders.bind(stockProblemsController))
);
router.post(
  '/stock-problems/orders/refresh-flags',
  requireAuth,
  wrapAsync(stockProblemsController.refreshFlags.bind(stockProblemsController))
);

// Инвентаризация — явные маршруты (вложенный Router у части окружений не матчил POST /apply)
router.get(
  '/inventory-sessions',
  requireAuth,
  wrapAsync(inventorySessionsController.list.bind(inventorySessionsController))
);
router.post(
  '/inventory-sessions/apply',
  requireAuth,
  wrapAsync(inventorySessionsController.apply.bind(inventorySessionsController))
);
router.get(
  '/inventory-sessions/:id',
  requireAuth,
  wrapAsync(inventorySessionsController.getById.bind(inventorySessionsController))
);
router.delete(
  '/inventory-sessions/:id',
  requireAuth,
  wrapAsync(inventorySessionsController.delete.bind(inventorySessionsController))
);

// Кабинеты маркетплейсов по организациям (до /organizations, чтобы :organizationId не перехватывался как :id)
router.use('/organizations/:organizationId/marketplace-cabinets', marketplaceCabinetsRoutes);
// Организации
router.use('/organizations', organizationsRoutes);

// Test endpoint
router.get('/test', (req, res) => {
  res.json({
    ok: true,
    message: 'API is working!',
    timestamp: new Date().toISOString()
  });
});

export default router;

