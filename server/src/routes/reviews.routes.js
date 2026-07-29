/**
 * Reviews Routes
 * Отзывы покупателей с маркетплейсов (Ozon/WB/Yandex)
 */

import express from 'express';
import reviewsController from '../controllers/reviews.controller.js';
import reviewAnswerTemplatesController from '../controllers/reviewAnswerTemplates.controller.js';
import reviewAutoReplyRulesController from '../controllers/reviewAutoReplyRules.controller.js';
import { requireAuth, requireProfile } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireProfile);

router.get(
  '/answer-templates',
  wrapAsync(reviewAnswerTemplatesController.list.bind(reviewAnswerTemplatesController))
);
router.post(
  '/answer-templates',
  wrapAsync(reviewAnswerTemplatesController.create.bind(reviewAnswerTemplatesController))
);
router.put(
  '/answer-templates/:templateId',
  wrapAsync(reviewAnswerTemplatesController.update.bind(reviewAnswerTemplatesController))
);
router.delete(
  '/answer-templates/:templateId',
  wrapAsync(reviewAnswerTemplatesController.remove.bind(reviewAnswerTemplatesController))
);

router.get(
  '/auto-reply-rules',
  wrapAsync(reviewAutoReplyRulesController.list.bind(reviewAutoReplyRulesController))
);
router.put(
  '/auto-reply-rules',
  wrapAsync(reviewAutoReplyRulesController.saveAll.bind(reviewAutoReplyRulesController))
);
router.post(
  '/auto-reply-rules/run',
  wrapAsync(reviewAutoReplyRulesController.runNow.bind(reviewAutoReplyRulesController))
);

router.get('/', wrapAsync(reviewsController.getList.bind(reviewsController)));
router.get('/stats', wrapAsync(reviewsController.getStats.bind(reviewsController)));
router.post('/sync', wrapAsync(reviewsController.sync.bind(reviewsController)));
router.post('/:id/answer', wrapAsync(reviewsController.answer.bind(reviewsController)));

export default router;
