/**
 * Brands Routes
 * Маршруты для управления брендами
 */

import express from 'express';
import { brandsController } from '../controllers/brands.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(brandsController.getAll));
router.get('/:id', wrapAsync(brandsController.getById));
router.post('/', wrapAsync(brandsController.create));
router.put('/:id', wrapAsync(brandsController.update));
router.delete('/:id', wrapAsync(brandsController.delete));

export { router as brandsRoutes };

