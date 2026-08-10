/**
 * TN VED Routes
 */

import express from 'express';
import tnVedController from '../controllers/tnVed.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/codes', wrapAsync(tnVedController.searchCodes.bind(tnVedController)));
router.get('/bindings', wrapAsync(tnVedController.getBindings.bind(tnVedController)));
router.get('/bindings/:id', wrapAsync(tnVedController.getBindingById.bind(tnVedController)));
router.post('/bindings', wrapAsync(tnVedController.createBinding.bind(tnVedController)));
router.put('/bindings/:id', wrapAsync(tnVedController.updateBinding.bind(tnVedController)));
router.delete('/bindings/:id', wrapAsync(tnVedController.deleteBinding.bind(tnVedController)));

export default router;
