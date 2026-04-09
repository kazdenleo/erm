/**
 * Organizations Routes
 * Маршруты для управления организациями
 */

import express from 'express';
import { organizationsController } from '../controllers/organizations.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

router.get('/', wrapAsync(organizationsController.getAll));
router.get('/:id', wrapAsync(organizationsController.getById));
router.post('/', wrapAsync(organizationsController.create));
router.put('/:id', wrapAsync(organizationsController.update));
router.delete('/:id', wrapAsync(organizationsController.delete));

export default router;
