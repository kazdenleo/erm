/**
 * Production Routes — сборка комплектов.
 */

import express from 'express';
import productionController from '../controllers/production.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get(
  '/kit-preview',
  requireAuth,
  wrapAsync(productionController.kitPreview.bind(productionController))
);

router.post(
  '/assemble-kit',
  requireAuth,
  wrapAsync(productionController.assembleKit.bind(productionController))
);

export default router;
