import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/marketplaceFbsReports.controller.js';

const router = express.Router();

router.use(requireAuth);

router.post('/sync', wrapAsync(controller.syncFbsReports));
router.get('/by-product', wrapAsync(controller.getFbsByProduct));
router.get('/by-order', wrapAsync(controller.getFbsByOrder));

export default router;
