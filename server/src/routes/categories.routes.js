/**
 * Categories Routes
 * Маршруты для управления категориями
 */

import express from 'express';
import { categoriesController } from '../controllers/categories.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(categoriesController.getAll));
router.get('/:id', wrapAsync(categoriesController.getById));
router.post('/', wrapAsync(categoriesController.create));
router.put('/:id', wrapAsync(categoriesController.update));
router.delete('/:id', wrapAsync(categoriesController.delete));

export { router as categoriesRoutes };

