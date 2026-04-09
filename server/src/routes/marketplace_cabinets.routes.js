/**
 * Marketplace Cabinets Routes
 * Вложенный маршрут: /organizations/:organizationId/marketplace-cabinets
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { marketplaceCabinetsController } from '../controllers/marketplace_cabinets.controller.js';

const router = express.Router({ mergeParams: true });

router.get('/', wrapAsync(marketplaceCabinetsController.list));
router.get('/:id', wrapAsync(marketplaceCabinetsController.getById));
router.post('/', wrapAsync(marketplaceCabinetsController.create));
router.put('/:id', wrapAsync(marketplaceCabinetsController.update));
router.delete('/:id', wrapAsync(marketplaceCabinetsController.delete));

export default router;
