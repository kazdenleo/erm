/**
 * API пользователей аккаунта: операционные новости маркетплейсов (тарифы / условия).
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/marketplaceNews.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', wrapAsync(controller.listNews));
router.post('/read-all', wrapAsync(controller.markAllRead));
router.get('/:id', wrapAsync(controller.getNews));
router.post('/:id/read', wrapAsync(controller.markRead));

export default router;
