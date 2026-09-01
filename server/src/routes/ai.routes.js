import express from 'express';
import { requireAuth, requireProfileAdmin } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/ai.controller.js';

const router = express.Router();

router.use(requireAuth); // JWT; ключ GigaChat только на сервере

router.get('/config', wrapAsync(controller.getConfig));
router.put('/config', requireProfileAdmin, wrapAsync(controller.saveConfig));
router.post('/test', requireProfileAdmin, wrapAsync(controller.testConnection));
router.post('/chat', wrapAsync(controller.chat));
router.post('/product-card/propose', wrapAsync(controller.proposeProductCard));
router.post('/product-card/propose-bulk', wrapAsync(controller.proposeProductCardsBulk));

export default router;

