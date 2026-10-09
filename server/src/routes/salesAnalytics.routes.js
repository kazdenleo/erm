import express from 'express';
import { requireAuth, requireProfileAdmin } from '../middleware/auth.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import * as controller from '../controllers/salesAnalytics.controller.js';
import * as hypothesesController from '../controllers/productHypotheses.controller.js';

const router = express.Router();

router.use(requireAuth);

router.get('/home-dynamics', wrapAsync(controller.getHomeDynamics));
router.get('/fbs-by-product', wrapAsync(controller.getFbsByProduct));
router.get('/by-category', wrapAsync(controller.getByCategory));
router.get('/abc', wrapAsync(controller.getAbcAnalysis));
router.get('/product-dynamics', wrapAsync(controller.getProductDynamics));
router.get('/turnover', wrapAsync(controller.getTurnover));
router.get('/card-work', wrapAsync(controller.getCardWork));
router.get('/card-work/duplicates', wrapAsync(controller.getCardWorkDuplicates));
router.get('/card-work/missing-cost', wrapAsync(controller.getCardWorkMissingCost));
router.get('/lost-revenue', wrapAsync(controller.getLostRevenue));
router.get('/returns', wrapAsync(controller.getReturns));
router.get('/dead-stock', wrapAsync(controller.getDeadStock));
router.get('/penalties', wrapAsync(controller.getPenalties));
router.get('/employees', requireProfileAdmin, wrapAsync(controller.getEmployeeMetrics));
router.get('/pnl', requireProfileAdmin, wrapAsync(controller.getPnl));
router.get('/expenses', requireProfileAdmin, wrapAsync(controller.listExpenses));
router.post('/expenses', requireProfileAdmin, wrapAsync(controller.createExpense));
router.put('/expenses/:id', requireProfileAdmin, wrapAsync(controller.updateExpense));
router.delete('/expenses/:id', requireProfileAdmin, wrapAsync(controller.deleteExpense));
router.get('/hypotheses', wrapAsync(hypothesesController.list));
router.post('/hypotheses', wrapAsync(hypothesesController.create));
router.patch('/hypotheses/:id', wrapAsync(hypothesesController.update));
router.delete('/hypotheses/:id', wrapAsync(hypothesesController.remove));

export default router;
