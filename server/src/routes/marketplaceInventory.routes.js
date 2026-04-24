import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/marketplaceInventory.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get('/summary', wrapAsync(controller.getSummary));
router.post('/run-now', wrapAsync(controller.runNow));

export default router;

