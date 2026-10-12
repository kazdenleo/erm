/**
 * Адресное хранение: ячейки, закрепление товаров, перемещения, план склада.
 */

import express from 'express';
import addressStorageController from '../controllers/addressStorage.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const c = (name) => wrapAsync(addressStorageController[name].bind(addressStorageController));

router.use(requireAuth);

router.get('/warehouses', c('listWarehouses'));
router.post('/lookup', c('lookup'));
router.get('/products/:productId', c('productLocations'));

const wh = '/warehouses/:warehouseId';
router.get(`${wh}/settings`, c('getSettings'));
router.put(`${wh}/settings`, c('saveSettings'));

router.get(`${wh}/locations`, c('listLocations'));
router.post(`${wh}/locations`, c('createLocation'));
router.post(`${wh}/locations/generate`, c('generateLocations'));
router.post(`${wh}/locations/bulk-update`, c('bulkUpdateLocations'));
router.post(`${wh}/locations/delete`, c('deleteLocations'));
router.post(`${wh}/locations/renumber`, c('renumberRoute'));
router.post(`${wh}/locations/labels`, c('labels'));
router.patch(`${wh}/locations/:locationId`, c('updateLocation'));

router.get(`${wh}/products`, c('searchProducts'));
router.put(`${wh}/assignments`, c('assignProduct'));
router.post(`${wh}/assignments/import`, c('importAssignments'));

router.get(`${wh}/resolve`, c('resolveScan'));
router.post(`${wh}/moves`, c('moveStock'));
router.post(`${wh}/moves/place-assigned`, c('placeUnplacedToAssigned'));
router.get(`${wh}/movements`, c('listMovements'));
router.get(`${wh}/pending`, c('listPending'));

router.get(`${wh}/heatmap`, c('getHeatmap'));
router.get(`${wh}/layout`, c('getLayout'));
router.put(`${wh}/layout`, c('saveLayout'));

export default router;
