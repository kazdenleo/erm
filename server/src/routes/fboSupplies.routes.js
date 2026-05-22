/**
 * FBO Supplies Routes
 */

import express from 'express';
import fboSuppliesController from '../controllers/fboSupplies.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { createProductExcelImportUpload } from '../middleware/uploads.js';

const router = express.Router();
const excelUpload = createProductExcelImportUpload();

router.use(requireAuth);

router.get('/', wrapAsync(fboSuppliesController.list.bind(fboSuppliesController)));
router.post('/', wrapAsync(fboSuppliesController.create.bind(fboSuppliesController)));

router.get(
  '/import/template/excel',
  wrapAsync(fboSuppliesController.downloadImportTemplateExcel.bind(fboSuppliesController))
);
router.post(
  '/import/api/preview',
  wrapAsync(fboSuppliesController.previewApiImport.bind(fboSuppliesController))
);
router.post(
  '/import/excel/preview',
  excelUpload.single('file'),
  wrapAsync(fboSuppliesController.previewExcelImport.bind(fboSuppliesController))
);
router.post(
  '/import/confirm',
  wrapAsync(fboSuppliesController.confirmImport.bind(fboSuppliesController))
);

router.get('/:id', wrapAsync(fboSuppliesController.getById.bind(fboSuppliesController)));
router.put('/:id', wrapAsync(fboSuppliesController.update.bind(fboSuppliesController)));
router.post('/:id/advance-status', wrapAsync(fboSuppliesController.advanceStatus.bind(fboSuppliesController)));
router.delete('/:id', wrapAsync(fboSuppliesController.delete.bind(fboSuppliesController)));

export default router;
