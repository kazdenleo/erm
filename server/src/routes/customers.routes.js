/**
 * Клиенты (частные заказы)
 */

import express from 'express';
import customersController from '../controllers/customers.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);
router.use(wrapAsync(customersController.requirePrivateOrders.bind(customersController)));

router.get('/', wrapAsync(customersController.list.bind(customersController)));
router.post('/', wrapAsync(customersController.create.bind(customersController)));
router.get('/:customerId', wrapAsync(customersController.getOne.bind(customersController)));
router.get('/:customerId/orders', wrapAsync(customersController.getOrders.bind(customersController)));
router.put('/:customerId', wrapAsync(customersController.update.bind(customersController)));
router.delete('/:customerId', wrapAsync(customersController.remove.bind(customersController)));

export default router;
