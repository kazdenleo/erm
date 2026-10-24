import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import cellLabelTemplatesController from '../controllers/cellLabelTemplates.controller.js';

const router = express.Router();

router.use(authenticateToken);
router.get('/', wrapAsync(cellLabelTemplatesController.get.bind(cellLabelTemplatesController)));
router.put('/', wrapAsync(cellLabelTemplatesController.upsert.bind(cellLabelTemplatesController)));
router.post(
  '/preview',
  wrapAsync(cellLabelTemplatesController.preview.bind(cellLabelTemplatesController))
);
router.delete('/', wrapAsync(cellLabelTemplatesController.delete.bind(cellLabelTemplatesController)));

export default router;
