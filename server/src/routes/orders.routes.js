/**
 * Orders Routes
 * Маршруты для работы с заказами
 */

import express from 'express';
import ordersController from '../controllers/orders.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { strictRateLimiter } from '../middleware/security.js';
import { requireAuth } from '../middleware/auth.js';
import {
  validateSyncOrders,
  validateOrderId,
  validateOrderDetailParams,
} from '../validators/orderValidator.js';

const router = express.Router();

router.use(requireAuth);

// Получить все заказы
router.get('/', wrapAsync(ordersController.getAll.bind(ordersController)));

// Счётчики по статусам для фильтра (по группам)
router.get(
  '/status-counts',
  wrapAsync(ordersController.getStatusCounts.bind(ordersController))
);

// Ручное добавление заказа (товар + количество)
router.post(
  '/manual',
  wrapAsync(ordersController.createManual.bind(ordersController))
);

// Синхронизация FBS‑заказов (с strict rate limit)
router.post(
  '/sync-fbs',
  strictRateLimiter,
  validateSyncOrders,
  wrapAsync(ordersController.syncFbs.bind(ordersController))
);

// Пауза фоновой синхронизации заказов с МП (cron); ручной sync-fbs всё ещё работает
router.get(
  '/sync-auto-pause',
  wrapAsync(ordersController.getOrdersFbsSyncPause.bind(ordersController))
);
router.post(
  '/sync-auto-pause',
  wrapAsync(ordersController.setOrdersFbsSyncPause.bind(ordersController))
);

// Принудительное обновление конкретного заказа Ozon
router.post(
  '/ozon/:orderId/refresh',
  validateOrderId,
  wrapAsync(ordersController.refreshOzon.bind(ordersController))
);

// Отправить выбранные заказы на сборку
router.post(
  '/send-to-assembly',
  wrapAsync(ordersController.sendToAssembly.bind(ordersController))
);

// Вернуть заказ в статус «Новый» (со сборки / собран)
router.put(
  '/:marketplace/:orderId/return-to-new',
  validateOrderDetailParams,
  wrapAsync(ordersController.returnToNew.bind(ordersController))
);

// Перевести заказ в статус «В закупке» (только из статуса «Новый»)
router.put(
  '/:marketplace/:orderId/to-procurement',
  validateOrderDetailParams,
  wrapAsync(ordersController.setToProcurement.bind(ordersController))
);

// Отменить заказ Wildberries через API маркетплейса
router.put(
  '/:marketplace/:orderId/cancel-marketplace',
  validateOrderDetailParams,
  wrapAsync(ordersController.cancelWildberries.bind(ordersController))
);

// Отметить заказ как отгруженный (для ручных заказов — тестирование)
router.put(
  '/:marketplace/:orderId/mark-shipped',
  validateOrderDetailParams,
  wrapAsync(ordersController.markShipped.bind(ordersController))
);

// Удалить заказ (для ручных заказов; при группе удаляется вся группа)
router.delete(
  '/:marketplace/:orderId',
  validateOrderDetailParams,
  wrapAsync(ordersController.deleteOrder.bind(ordersController))
);

// Детальная информация по заказу (Ozon: fbs/get, WB: список по id)
router.get(
  '/:marketplace/:orderId/detail',
  validateOrderDetailParams,
  wrapAsync(ordersController.getDetail.bind(ordersController))
);

// Страница с этикеткой и автопечатью (для сборки — сразу печатать)
router.get(
  '/:orderId/label/print',
  validateOrderId,
  wrapAsync(ordersController.getLabelPrint.bind(ordersController))
);

// Получить этикетку заказа (изображение/PDF)
router.get(
  '/:orderId/label',
  validateOrderId,
  wrapAsync(ordersController.getLabel.bind(ordersController))
);

// Статус наличия этикетки
router.get(
  '/:orderId/label/status',
  validateOrderId,
  wrapAsync(ordersController.getLabelStatus.bind(ordersController))
);

// Ручная предзагрузка этикеток
router.post(
  '/preload-labels',
  wrapAsync(ordersController.preloadLabels.bind(ordersController))
);

export default router;


