/**
 * Users Routes
 * Управление пользователями (в рамках своего профиля или все для admin)
 */

import express from 'express';
import { usersController } from '../controllers/users.controller.js';
import { homeWidgetsController } from '../controllers/homeWidgets.controller.js';
import * as demoUxController from '../controllers/demoUx.controller.js';
import { requireAuth, requireNavSection } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';

const router = express.Router();

// optionalAuth уже выполнен в главном router/index.js для всех /api/*
router.use(requireAuth);

router.get('/me', wrapAsync(usersController.getMe));
router.put('/me', wrapAsync(usersController.updateMe));
router.get('/me/home-widgets', wrapAsync(homeWidgetsController.get));
router.put('/me/home-widgets', wrapAsync(homeWidgetsController.update));
router.get('/me/ux-progress', wrapAsync(demoUxController.getUx));
router.patch('/me/ux-progress', wrapAsync(demoUxController.patchUx));
router.post('/me/demo-extend', wrapAsync(demoUxController.extendDemo));

// Список пользователей для выбора (приглашения, назначения и т.п.) — без прав администратора.
router.get('/invite-candidates', wrapAsync(usersController.getInviteCandidates));

const requireEmployeesAnalytics = requireNavSection('analytics_employees');
router.get('/payroll', requireEmployeesAnalytics, wrapAsync(usersController.getPayroll));
router.get('/:id/payroll', requireEmployeesAnalytics, wrapAsync(usersController.getUserPayroll));
router.put('/:id/absences', requireEmployeesAnalytics, wrapAsync(usersController.replaceUserAbsences));
router.post('/:id/absences/toggle', requireEmployeesAnalytics, wrapAsync(usersController.toggleUserAbsence));

router.get('/', wrapAsync(usersController.getAll));
router.get('/:id', wrapAsync(usersController.getById));
router.post('/', wrapAsync(usersController.create));
router.put('/:id', wrapAsync(usersController.update));
router.delete('/:id', wrapAsync(usersController.delete));

export default router;
