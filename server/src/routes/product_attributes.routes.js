/**
 * Product Attributes Routes
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import productAttributesController from '../controllers/product_attributes.controller.js';

const router = express.Router();

router.get('/', wrapAsync(productAttributesController.getAll.bind(productAttributesController)));
router.get('/:id', wrapAsync(productAttributesController.getById.bind(productAttributesController)));
router.post('/', wrapAsync(productAttributesController.create.bind(productAttributesController)));
router.put('/:id', wrapAsync(productAttributesController.update.bind(productAttributesController)));
router.delete('/:id', wrapAsync(productAttributesController.delete.bind(productAttributesController)));

export default router;
