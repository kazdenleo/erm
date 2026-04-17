/**
 * Вопросы покупателей с маркетплейсов
 */

import express from 'express';
import questionsController from '../controllers/questions.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', wrapAsync(questionsController.getList.bind(questionsController)));
router.get('/stats', wrapAsync(questionsController.getStats.bind(questionsController)));
router.post('/sync', wrapAsync(questionsController.sync.bind(questionsController)));
router.post('/:id/answer', wrapAsync(questionsController.answer.bind(questionsController)));

export default router;
