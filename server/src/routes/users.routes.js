/**
 * Users Routes
 * Управление пользователями (в рамках своего профиля или все для admin)
 */

import express from 'express';
import { usersController } from '../controllers/users.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

// optionalAuth уже выполнен в главном router/index.js для всех /api/*
router.use(requireAuth);

router.get('/me', wrapAsync(usersController.getMe));
router.put('/me', wrapAsync(usersController.updateMe));

// Список пользователей для выбора (приглашения, назначения и т.п.) — без прав администратора.
router.get('/invite-candidates', wrapAsync(usersController.getInviteCandidates));

router.get('/', wrapAsync(usersController.getAll));
router.get('/:id', wrapAsync(usersController.getById));
router.post('/', wrapAsync(usersController.create));
router.put('/:id', wrapAsync(usersController.update));
router.delete('/:id', wrapAsync(usersController.delete));

export default router;
