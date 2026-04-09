/**
 * Auth Routes
 * Вход и текущий пользователь
 */

import express from 'express';
import { authController } from '../controllers/auth.controller.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { strictRateLimiter } from '../middleware/security.js';

const router = express.Router();

router.post('/register-account', strictRateLimiter, wrapAsync(authController.registerAccount));
router.post('/login', wrapAsync(authController.login));
router.post('/change-password', optionalAuth, requireAuth, wrapAsync(authController.changePassword));
router.get('/me', optionalAuth, requireAuth, wrapAsync(authController.me));

export default router;
