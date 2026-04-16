/**
 * Profiles Routes
 * Своё: GET/PUT /me — администратор аккаунта; остальное — администратор продукта
 */

import express from 'express';
import { profilesController } from '../controllers/profiles.controller.js';
import { requireAuth, requireAdmin, requireProfile, requireProfileAdmin } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

// optionalAuth уже выполнен в главном router/index.js для всех /api/*
router.use(requireAuth);

router.get('/me', requireProfile, requireProfileAdmin, wrapAsync(profilesController.getMyProfile));
router.put('/me', requireProfile, requireProfileAdmin, wrapAsync(profilesController.updateMyProfile));

router.use(requireAdmin);

router.get('/', wrapAsync(profilesController.getAll));
router.get('/:id/cabinet', wrapAsync(profilesController.getCabinet));
router.get('/:id', wrapAsync(profilesController.getById));
router.post('/', wrapAsync(profilesController.create));
router.put('/:id', wrapAsync(profilesController.update));
router.delete('/:id', wrapAsync(profilesController.delete));

export default router;
