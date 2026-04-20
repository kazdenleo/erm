/**
 * Reviews Routes
 * Отзывы покупателей с маркетплейсов (Ozon/WB/Yandex)
 */

import express from 'express';
import reviewsController from '../controllers/reviews.controller.js';
import { requireAuth, requireProfile } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireProfile);

router.get('/', wrapAsync(reviewsController.getList.bind(reviewsController)));
router.get('/stats', wrapAsync(reviewsController.getStats.bind(reviewsController)));
router.post('/sync', wrapAsync(reviewsController.sync.bind(reviewsController)));
router.post('/:id/answer', wrapAsync(reviewsController.answer.bind(reviewsController)));

export default router;

