/**
 * Warehouse Receipts Routes
 * Приёмки товаров на склад
 */

import express from 'express';
import warehouseReceiptsController from '../controllers/warehouseReceipts.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(warehouseReceiptsController.list.bind(warehouseReceiptsController)));

// Общая "живая" приёмка (несколько устройств) — хранится в памяти процесса (подходит для локалки / single-instance).
router.post('/sessions', wrapAsync(warehouseReceiptsController.createSession.bind(warehouseReceiptsController)));
router.get('/sessions/:id', wrapAsync(warehouseReceiptsController.getSession.bind(warehouseReceiptsController)));
router.post('/sessions/:id/add-quantity', wrapAsync(warehouseReceiptsController.addSessionQuantity.bind(warehouseReceiptsController)));
router.post('/sessions/:id/complete', wrapAsync(warehouseReceiptsController.completeSession.bind(warehouseReceiptsController)));
router.post('/sessions/:id/invite', wrapAsync(warehouseReceiptsController.inviteToSession.bind(warehouseReceiptsController)));

router.get('/:id', wrapAsync(warehouseReceiptsController.getById.bind(warehouseReceiptsController)));
router.put('/:id', wrapAsync(warehouseReceiptsController.update.bind(warehouseReceiptsController)));
router.post('/', wrapAsync(warehouseReceiptsController.create.bind(warehouseReceiptsController)));
router.delete('/:id', wrapAsync(warehouseReceiptsController.delete.bind(warehouseReceiptsController)));

export default router;
