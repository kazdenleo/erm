import express from 'express';
import { pricingStrategiesController } from '../controllers/pricingStrategies.controller.js';

const router = express.Router();

router.get('/defaults', (req, res, next) => pricingStrategiesController.defaults(req, res, next));
router.get('/settings', (req, res, next) => pricingStrategiesController.getSettings(req, res, next));
router.put('/settings', (req, res, next) => pricingStrategiesController.updateSettings(req, res, next));
router.post('/recalculate-product', (req, res, next) =>
  pricingStrategiesController.recalculateProduct(req, res, next)
);
router.post('/preview', (req, res, next) => pricingStrategiesController.preview(req, res, next));
router.get('/', (req, res, next) => pricingStrategiesController.list(req, res, next));
router.post('/', (req, res, next) => pricingStrategiesController.create(req, res, next));
router.get('/:id', (req, res, next) => pricingStrategiesController.getOne(req, res, next));
router.put('/:id', (req, res, next) => pricingStrategiesController.update(req, res, next));
router.delete('/:id', (req, res, next) => pricingStrategiesController.remove(req, res, next));

export default router;
