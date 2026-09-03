import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import categoryVideoCoverTemplatesController from '../controllers/categoryVideoCoverTemplates.controller.js';

const router = express.Router();

router.get('/', wrapAsync(categoryVideoCoverTemplatesController.getAll.bind(categoryVideoCoverTemplatesController)));
router.get(
  '/shared',
  wrapAsync(categoryVideoCoverTemplatesController.getShared.bind(categoryVideoCoverTemplatesController))
);
router.put(
  '/shared',
  wrapAsync(categoryVideoCoverTemplatesController.upsertShared.bind(categoryVideoCoverTemplatesController))
);
router.delete(
  '/shared',
  wrapAsync(categoryVideoCoverTemplatesController.deleteShared.bind(categoryVideoCoverTemplatesController))
);
router.get(
  '/by-category/:categoryId',
  wrapAsync(categoryVideoCoverTemplatesController.getByCategoryId.bind(categoryVideoCoverTemplatesController))
);
router.put(
  '/by-category/:categoryId',
  wrapAsync(categoryVideoCoverTemplatesController.upsert.bind(categoryVideoCoverTemplatesController))
);
router.delete(
  '/by-category/:categoryId',
  wrapAsync(categoryVideoCoverTemplatesController.delete.bind(categoryVideoCoverTemplatesController))
);

export default router;
