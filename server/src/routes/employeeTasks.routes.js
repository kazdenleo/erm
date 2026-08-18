/**
 * Employee Tasks Routes
 */

import express from 'express';
import { employeeTasksController } from '../controllers/employeeTasks.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', wrapAsync(employeeTasksController.getAll));
router.get('/stats', wrapAsync(employeeTasksController.getStats));
router.get('/:id/product-create-status', wrapAsync(employeeTasksController.getProductCreateStatus));
router.post('/', wrapAsync(employeeTasksController.create));
router.post('/:id/complete', wrapAsync(employeeTasksController.complete));
router.post('/:id/reassign', wrapAsync(employeeTasksController.reassign));

export { router as employeeTasksRoutes };
