/**
 * Шаблон этикетки ШК упаковки
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import packagingLabelTemplatesController from '../controllers/packagingLabelTemplates.controller.js';

const router = express.Router();

router.get('/', wrapAsync(packagingLabelTemplatesController.get.bind(packagingLabelTemplatesController)));
router.put('/', wrapAsync(packagingLabelTemplatesController.upsert.bind(packagingLabelTemplatesController)));
router.post(
  '/preview',
  wrapAsync(packagingLabelTemplatesController.preview.bind(packagingLabelTemplatesController))
);
router.delete('/', wrapAsync(packagingLabelTemplatesController.delete.bind(packagingLabelTemplatesController)));

export default router;
