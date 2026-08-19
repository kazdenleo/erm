/**
 * Заявки на возврат с маркетплейсов (решение продавца)
 */

import express from 'express';
import marketplaceReturnClaimsController from '../controllers/marketplaceReturnClaims.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/stats', wrapAsync(marketplaceReturnClaimsController.getStats.bind(marketplaceReturnClaimsController)));
router.post('/sync', wrapAsync(marketplaceReturnClaimsController.sync.bind(marketplaceReturnClaimsController)));
router.get('/', wrapAsync(marketplaceReturnClaimsController.getList.bind(marketplaceReturnClaimsController)));
router.get('/:id', wrapAsync(marketplaceReturnClaimsController.getOne.bind(marketplaceReturnClaimsController)));
router.post(
  '/:id/decide',
  wrapAsync(marketplaceReturnClaimsController.decide.bind(marketplaceReturnClaimsController))
);

export default router;
