import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { strictRateLimiter } from '../middleware/security.js';
import * as ctrl from '../controllers/onlineStore.controller.js';

const router = express.Router();

/** Публичная витрина (без JWT). */
router.get('/public-by-host', wrapAsync(ctrl.publicGetStoreByHost));
router.get('/public/:slug', wrapAsync(ctrl.publicGetStore));
router.get('/public/:slug/products', wrapAsync(ctrl.publicListProducts));
router.get('/public/:slug/products/:productId', wrapAsync(ctrl.publicGetProduct));
router.post('/public/:slug/checkout', strictRateLimiter, wrapAsync(ctrl.publicCheckout));

/** Кабинет. */
router.get('/templates', requireAuth, wrapAsync(ctrl.getTemplates));
router.get('/me', requireAuth, wrapAsync(ctrl.getMine));
router.put('/me', requireAuth, wrapAsync(ctrl.saveMine));

export default router;
