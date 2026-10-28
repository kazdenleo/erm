import express from 'express';
import adsController from '../controllers/ads.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/dashboard', (req, res, next) => adsController.dashboard(req, res, next));
router.post('/sync', (req, res, next) => adsController.sync(req, res, next));
router.post('/test/:marketplace', (req, res, next) => adsController.testConnection(req, res, next));

router.get('/campaigns', (req, res, next) => adsController.listCampaigns(req, res, next));
router.get('/campaigns/:id', (req, res, next) => adsController.getCampaign(req, res, next));
router.patch('/campaigns/:id', (req, res, next) => adsController.patchCampaign(req, res, next));
router.patch('/campaigns/:id/products/:productId', (req, res, next) =>
  adsController.patchCampaignProduct(req, res, next)
);

router.get('/actions', (req, res, next) => adsController.actionLog(req, res, next));

router.get('/automation/rules', (req, res, next) => adsController.listRules(req, res, next));
router.post('/automation/rules', (req, res, next) => adsController.createRule(req, res, next));
router.put('/automation/rules/:id', (req, res, next) => adsController.updateRule(req, res, next));
router.delete('/automation/rules/:id', (req, res, next) => adsController.deleteRule(req, res, next));
router.get('/automation/runs', (req, res, next) => adsController.listAutomationRuns(req, res, next));
router.post('/automation/rules/:id/run', (req, res, next) => adsController.runRule(req, res, next));
router.post('/automation/run', (req, res, next) => adsController.runAutomation(req, res, next));

export default router;
