/**
 * Purchase Cargo Places Routes
 * Грузоместа закупки: приёмка мест, вскрытие и приёмка товара из них.
 */

import express from 'express';
import controller from '../controllers/purchaseCargoPlaces.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/purchases', controller.listPurchases);
router.get('/purchases/:purchaseId', controller.getPurchase);
router.put('/purchases/:purchaseId/expected', controller.setExpected);
router.post('/purchases/:purchaseId/places', controller.acceptPlace);

router.get('/places/:placeId', controller.getPlace);
router.post('/places/:placeId/remove', controller.removePlace);
router.post('/places/:placeId/open', controller.openPlace);
router.post('/places/:placeId/close', controller.closePlace);
router.post('/places/:placeId/items', controller.addItem);
router.post('/places/:placeId/items/set', controller.setItemQuantity);

export default router;
