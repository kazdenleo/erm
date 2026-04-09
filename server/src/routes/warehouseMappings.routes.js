/**
 * Warehouse Mappings Routes
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import warehouseMappingsController from '../controllers/warehouseMappings.controller.js';
import {
  validateWarehouseMappingId,
  validateCreateWarehouseMapping,
  validateUpdateWarehouseMapping,
} from '../validators/warehouseMappingsValidator.js';

const router = express.Router();

router.get('/', requireAuth, wrapAsync(warehouseMappingsController.list.bind(warehouseMappingsController)));
router.post('/', requireAuth, validateCreateWarehouseMapping, wrapAsync(warehouseMappingsController.create.bind(warehouseMappingsController)));
router.put('/:id', requireAuth, validateWarehouseMappingId, validateUpdateWarehouseMapping, wrapAsync(warehouseMappingsController.update.bind(warehouseMappingsController)));
router.delete('/:id', requireAuth, validateWarehouseMappingId, wrapAsync(warehouseMappingsController.delete.bind(warehouseMappingsController)));

export default router;

