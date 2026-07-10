import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/marketplaceFboReports.controller.js';

const router = express.Router();

router.use(requireAuth);

router.post('/sync', wrapAsync(controller.syncFboReports));
router.get('/by-product', wrapAsync(controller.getFboByProduct));
router.get('/by-order', wrapAsync(controller.getFboByOrder));

export default router;
