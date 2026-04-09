/**
 * Purchases Routes
 * Закупки и приёмки по закупке.
 */

import express from 'express';
import purchasesController from '../controllers/purchases.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

// закупки
router.get('/', wrapAsync(purchasesController.list.bind(purchasesController)));
router.post('/', wrapAsync(purchasesController.create.bind(purchasesController)));
router.get('/:id', wrapAsync(purchasesController.getById.bind(purchasesController)));
router.post('/:id/draft-items', wrapAsync(purchasesController.appendDraftItems.bind(purchasesController)));
router.delete('/:id/items/:itemId', wrapAsync(purchasesController.removeDraftLineItem.bind(purchasesController)));
router.put('/:id', wrapAsync(purchasesController.updatePurchase.bind(purchasesController)));
router.put('/:id/items/:itemId', wrapAsync(purchasesController.updatePurchaseItem.bind(purchasesController)));
router.post('/:id/mark-ordered', wrapAsync(purchasesController.markOrdered.bind(purchasesController)));
router.post('/:id/receipts', wrapAsync(purchasesController.createReceipt.bind(purchasesController)));

// приёмки по закупке
router.get('/receipts/:receiptId', wrapAsync(purchasesController.getReceipt.bind(purchasesController)));
router.post('/receipts/:receiptId/scan', wrapAsync(purchasesController.scanReceipt.bind(purchasesController)));
router.post('/receipts/:receiptId/complete', wrapAsync(purchasesController.completeReceipt.bind(purchasesController)));
router.post('/receipts/:receiptId/resolve-extras', wrapAsync(purchasesController.resolveExtras.bind(purchasesController)));

// DELETE для закупки и приёмки см. routes/index.js (главный роутер)

export default router;

