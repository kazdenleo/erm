import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/salesAnalytics.controller.js';
import * as hypothesesController from '../controllers/productHypotheses.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get('/fbs-by-product', wrapAsync(controller.getFbsByProduct));
router.get('/by-category', wrapAsync(controller.getByCategory));
router.get('/abc', wrapAsync(controller.getAbcAnalysis));
router.get('/product-dynamics', wrapAsync(controller.getProductDynamics));
router.get('/turnover', wrapAsync(controller.getTurnover));
router.get('/card-work', wrapAsync(controller.getCardWork));
router.get('/hypotheses', wrapAsync(hypothesesController.list));
router.post('/hypotheses', wrapAsync(hypothesesController.create));
router.patch('/hypotheses/:id', wrapAsync(hypothesesController.update));
router.delete('/hypotheses/:id', wrapAsync(hypothesesController.remove));

export default router;
