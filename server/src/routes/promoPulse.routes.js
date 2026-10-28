import express from 'express';
import { promoPulseController } from '../controllers/promoPulse.controller.js';

const router = express.Router();

router.get('/ports', (req, res, next) => promoPulseController.ports(req, res, next));
router.get('/policies', (req, res, next) => promoPulseController.listPolicies(req, res, next));
router.post('/policies', (req, res, next) => promoPulseController.createPolicy(req, res, next));
router.put('/policies/:id', (req, res, next) => promoPulseController.updatePolicy(req, res, next));
router.post('/preview', (req, res, next) => promoPulseController.preview(req, res, next));
router.post('/run', (req, res, next) => promoPulseController.run(req, res, next));
router.get('/runs', (req, res, next) => promoPulseController.listRuns(req, res, next));
router.get('/runs/:id', (req, res, next) => promoPulseController.getRun(req, res, next));
router.get('/assignments', (req, res, next) => promoPulseController.listAssignments(req, res, next));
router.post('/assignments', (req, res, next) => promoPulseController.createAssignment(req, res, next));
router.delete('/assignments/:id', (req, res, next) => promoPulseController.deleteAssignment(req, res, next));
router.get('/states', (req, res, next) => promoPulseController.listStates(req, res, next));

export default router;
