/**
 * Приёмка грузомест без закупки.
 */

import express from 'express';
import controller from '../controllers/cargoBatches.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/batches', controller.list);
router.post('/batches', controller.create);
router.get('/batches/:batchId', controller.get);
router.put('/batches/:batchId/expected', controller.setExpected);
router.post('/batches/:batchId/places', controller.acceptPlace);
router.post('/batches/:batchId/complete', controller.complete);

router.get('/places/:placeId', controller.getPlace);
router.post('/places/:placeId/remove', controller.removePlace);
router.post('/places/:placeId/open', controller.openPlace);
router.post('/places/:placeId/close', controller.closePlace);
router.post('/places/:placeId/items', controller.addItem);
router.post('/places/:placeId/items/set', controller.setItemQuantity);

export default router;
