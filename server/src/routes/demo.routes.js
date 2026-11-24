import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { strictRateLimiter } from '../middleware/security.js';
import * as demoController from '../controllers/demo.controller.js';

const router = express.Router();

router.post('/request', strictRateLimiter, wrapAsync(demoController.requestDemo));

export default router;
