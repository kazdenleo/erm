/**
 * API супер-админа: уведомления маркетплейсов (ключи + журнал).
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/platformMarketplaceNotifications.controller.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get('/settings', wrapAsync(controller.getSettings));
router.put('/settings', wrapAsync(controller.putSettings));
router.get('/events', wrapAsync(controller.listEvents));

export default router;
