/**
 * Шаблоны этикеток по категориям
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import categoryLabelTemplatesController from '../controllers/categoryLabelTemplates.controller.js';

const router = express.Router();

router.get('/', wrapAsync(categoryLabelTemplatesController.getAll.bind(categoryLabelTemplatesController)));
router.get(
  '/by-category/:categoryId',
  wrapAsync(categoryLabelTemplatesController.getByCategoryId.bind(categoryLabelTemplatesController))
);
router.put(
  '/by-category/:categoryId',
  wrapAsync(categoryLabelTemplatesController.upsert.bind(categoryLabelTemplatesController))
);
router.post(
  '/by-category/:categoryId/preview',
  wrapAsync(categoryLabelTemplatesController.preview.bind(categoryLabelTemplatesController))
);
router.delete(
  '/by-category/:categoryId',
  wrapAsync(categoryLabelTemplatesController.delete.bind(categoryLabelTemplatesController))
);

export default router;
