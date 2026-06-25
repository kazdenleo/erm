/**
 * Возвраты с маркетплейсов (ждут забора с ПВЗ)
 */

import express from 'express';
import marketplaceReturnsController from '../controllers/marketplaceReturns.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/stats', wrapAsync(marketplaceReturnsController.getStats.bind(marketplaceReturnsController)));
router.get('/', wrapAsync(marketplaceReturnsController.getList.bind(marketplaceReturnsController)));

export default router;
