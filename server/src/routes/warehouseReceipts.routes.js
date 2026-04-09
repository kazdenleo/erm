/**
 * Warehouse Receipts Routes
 * Приёмки товаров на склад
 */

import express from 'express';
import warehouseReceiptsController from '../controllers/warehouseReceipts.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(warehouseReceiptsController.list.bind(warehouseReceiptsController)));
router.get('/:id', wrapAsync(warehouseReceiptsController.getById.bind(warehouseReceiptsController)));
router.post('/', wrapAsync(warehouseReceiptsController.create.bind(warehouseReceiptsController)));
router.delete('/:id', wrapAsync(warehouseReceiptsController.delete.bind(warehouseReceiptsController)));

export default router;
