import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import cellLabelTemplatesController from '../controllers/cellLabelTemplates.controller.js';

const router = express.Router();

router.get('/', wrapAsync(cellLabelTemplatesController.get.bind(cellLabelTemplatesController)));
router.put('/', wrapAsync(cellLabelTemplatesController.upsert.bind(cellLabelTemplatesController)));
router.post(
  '/preview',
  wrapAsync(cellLabelTemplatesController.preview.bind(cellLabelTemplatesController))
);
router.delete('/', wrapAsync(cellLabelTemplatesController.delete.bind(cellLabelTemplatesController)));

export default router;
