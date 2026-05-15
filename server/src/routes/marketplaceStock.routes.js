import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import marketplaceStockController from '../controllers/marketplaceStock.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get(
  '/available/:productId',
  wrapAsync(marketplaceStockController.getAvailable.bind(marketplaceStockController))
);
router.post(
  '/sync/product/:productId',
  wrapAsync(marketplaceStockController.syncProduct.bind(marketplaceStockController))
);
router.post('/sync', wrapAsync(marketplaceStockController.syncBulk.bind(marketplaceStockController)));

export default router;
