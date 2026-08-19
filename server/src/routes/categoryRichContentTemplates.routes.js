import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { createRichContentBackgroundUpload } from '../middleware/uploads.js';
import categoryRichContentTemplatesController from '../controllers/categoryRichContentTemplates.controller.js';

const router = express.Router();
const uploadBackground = createRichContentBackgroundUpload();

router.get('/', wrapAsync(categoryRichContentTemplatesController.getAll.bind(categoryRichContentTemplatesController)));
router.post(
  '/background',
  uploadBackground.single('file'),
  wrapAsync(categoryRichContentTemplatesController.uploadBackground.bind(categoryRichContentTemplatesController))
);
router.get(
  '/shared',
  wrapAsync(categoryRichContentTemplatesController.getShared.bind(categoryRichContentTemplatesController))
);
router.put(
  '/shared',
  wrapAsync(categoryRichContentTemplatesController.upsertShared.bind(categoryRichContentTemplatesController))
);
router.delete(
  '/shared',
  wrapAsync(categoryRichContentTemplatesController.deleteShared.bind(categoryRichContentTemplatesController))
);
router.post(
  '/unify',
  wrapAsync(categoryRichContentTemplatesController.unify.bind(categoryRichContentTemplatesController))
);
router.get(
  '/by-category/:categoryId',
  wrapAsync(categoryRichContentTemplatesController.getByCategoryId.bind(categoryRichContentTemplatesController))
);
router.put(
  '/by-category/:categoryId',
  wrapAsync(categoryRichContentTemplatesController.upsert.bind(categoryRichContentTemplatesController))
);
router.post(
  '/by-category/:categoryId/sync-fields',
  wrapAsync(categoryRichContentTemplatesController.syncFields.bind(categoryRichContentTemplatesController))
);
router.delete(
  '/by-category/:categoryId',
  wrapAsync(categoryRichContentTemplatesController.delete.bind(categoryRichContentTemplatesController))
);

export default router;
