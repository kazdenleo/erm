/**
 * Downloads Routes
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { downloadPrintHelperInstaller } from '../controllers/downloads.controller.js';

const router = express.Router();

router.use(requireAuth);

// Установщик локального Print Helper (Windows)
router.get('/print-helper', wrapAsync(downloadPrintHelperInstaller));

export default router;

