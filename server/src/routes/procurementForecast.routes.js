import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/procurementForecast.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get('/fbs', wrapAsync(controller.getFbsForecast));

export default router;
