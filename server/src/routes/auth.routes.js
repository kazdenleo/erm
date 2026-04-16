/**
 * Auth Routes
 * Вход и текущий пользователь
 */

import express from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { strictRateLimiter } from '../middleware/security.js';

const router = express.Router();

router.post('/register-account', strictRateLimiter, wrapAsync(authController.registerAccount));
router.post('/login', wrapAsync(authController.login));
// optionalAuth уже в главном router/index.js для всех /api/*
router.post('/change-password', requireAuth, wrapAsync(authController.changePassword));
router.get('/me', requireAuth, wrapAsync(authController.me));

export default router;
