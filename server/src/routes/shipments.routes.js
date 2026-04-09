/**
 * Shipments Routes
 * Поставки FBS: создание (локально / WB на маркетплейсе), добавление заказов
 */

import express from 'express';
import shipmentsController from '../controllers/shipments.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(shipmentsController.getAll.bind(shipmentsController)));
router.get('/:id/qr-sticker/print', wrapAsync(shipmentsController.getQrStickerPrint.bind(shipmentsController)));
router.get('/:id/qr-sticker', wrapAsync(shipmentsController.getQrSticker.bind(shipmentsController)));
router.get('/:id', wrapAsync(shipmentsController.getById.bind(shipmentsController)));
router.post('/', wrapAsync(shipmentsController.create.bind(shipmentsController)));
router.post('/:id/orders', wrapAsync(shipmentsController.addOrders.bind(shipmentsController)));
router.post('/:id/orders/remove', wrapAsync(shipmentsController.removeOrders.bind(shipmentsController)));
router.post('/:id/close', wrapAsync(shipmentsController.close.bind(shipmentsController)));

export default router;
