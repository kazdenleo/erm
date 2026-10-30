import express from 'express';
import billingController from '../controllers/billing.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/plans', wrapAsync((req, res) => billingController.listPlans(req, res)));
router.get('/legal/offer', wrapAsync((req, res) => billingController.getOffer(req, res)));
router.get('/legal/privacy', wrapAsync((req, res) => billingController.getPrivacy(req, res)));

router.post(
  '/webhooks/yookassa',
  wrapAsync((req, res, next) => billingController.yookassaWebhook(req, res, next))
);

router.get('/usage', requireAuth, wrapAsync((req, res, next) => billingController.myUsage(req, res, next)));
router.get('/requests/mine', requireAuth, wrapAsync((req, res, next) => billingController.listMyRequests(req, res, next)));
router.post('/requests', requireAuth, wrapAsync((req, res, next) => billingController.createRequest(req, res, next)));
router.post('/checkout', requireAuth, wrapAsync((req, res, next) => billingController.createCheckout(req, res, next)));
router.post('/payments/sync', requireAuth, wrapAsync((req, res, next) => billingController.syncMyPayment(req, res, next)));
router.post('/requests/cancel', requireAuth, wrapAsync((req, res, next) => billingController.cancelMyRequest(req, res, next)));

router.get(
  '/admin/requests',
  requireAuth,
  requireAdmin,
  wrapAsync((req, res, next) => billingController.adminListRequests(req, res, next))
);
router.post(
  '/admin/requests/:id/approve',
  requireAuth,
  requireAdmin,
  wrapAsync((req, res, next) => billingController.adminApprove(req, res, next))
);
router.post(
  '/admin/requests/:id/reject',
  requireAuth,
  requireAdmin,
  wrapAsync((req, res, next) => billingController.adminReject(req, res, next))
);
router.get(
  '/admin/audit/:profileId',
  requireAuth,
  requireAdmin,
  wrapAsync((req, res, next) => billingController.adminAudit(req, res, next))
);

export default router;
