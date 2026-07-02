/**
 * Вопросы покупателей с маркетплейсов
 */

import express from 'express';
import questionsController from '../controllers/questions.controller.js';
import questionAnswerTemplatesController from '../controllers/questionAnswerTemplates.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get(
  '/answer-templates',
  wrapAsync(questionAnswerTemplatesController.list.bind(questionAnswerTemplatesController))
);
router.post(
  '/answer-templates',
  wrapAsync(questionAnswerTemplatesController.create.bind(questionAnswerTemplatesController))
);
router.put(
  '/answer-templates/:templateId',
  wrapAsync(questionAnswerTemplatesController.update.bind(questionAnswerTemplatesController))
);
router.delete(
  '/answer-templates/:templateId',
  wrapAsync(questionAnswerTemplatesController.remove.bind(questionAnswerTemplatesController))
);

router.get('/', wrapAsync(questionsController.getList.bind(questionsController)));
router.get('/stats', wrapAsync(questionsController.getStats.bind(questionsController)));
router.post('/sync', wrapAsync(questionsController.sync.bind(questionsController)));
router.get('/:id', wrapAsync(questionsController.getOne.bind(questionsController)));
router.post('/:id/answer', wrapAsync(questionsController.answer.bind(questionsController)));

export default router;
