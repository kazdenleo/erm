/**
 * API супер-админа: лента новостей маркетплейсов.
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/platformMarketplaceNews.controller.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get('/', wrapAsync(controller.listNews));
router.post('/sync', wrapAsync(controller.syncNews));
router.post('/read-all', wrapAsync(controller.markAllRead));
router.get('/:id', wrapAsync(controller.getNews));
router.post('/:id/read', wrapAsync(controller.markRead));

export default router;
