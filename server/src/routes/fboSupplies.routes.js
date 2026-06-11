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
router.get(
  '/deduction-warehouses',
  wrapAsync(fboSuppliesController.listDeductionWarehouses.bind(fboSuppliesController))
);
router.post('/', wrapAsync(fboSuppliesController.create.bind(fboSuppliesController)));
router.post(
  '/purchase-calculation',
  wrapAsync(fboSuppliesController.purchaseCalculation.bind(fboSuppliesController))
);
router.post(
  '/purchase-calculation/export/excel',
  wrapAsync(fboSuppliesController.exportPurchaseCalcExcel.bind(fboSuppliesController))
);

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

router.get(
  '/:id/packing/export/excel',
  wrapAsync(fboSuppliesController.downloadPackingExcel.bind(fboSuppliesController))
);
router.get('/:id/packing', wrapAsync(fboSuppliesController.getPacking.bind(fboSuppliesController)));
router.patch(
  '/:id/packing/contents/:contentId',
  wrapAsync(fboSuppliesController.packingUpdateContent.bind(fboSuppliesController))
);
router.post('/:id/packing/scan', wrapAsync(fboSuppliesController.packingScan.bind(fboSuppliesController)));
router.post(
  '/:id/packing/scan-remove',
  wrapAsync(fboSuppliesController.packingScanRemove.bind(fboSuppliesController))
);
router.patch(
  '/:id/packing/cargo-units/:cargoUnitId',
  wrapAsync(fboSuppliesController.packingUpdateCargoUnit.bind(fboSuppliesController))
);
router.delete(
  '/:id/packing/cargo-units/:cargoUnitId',
  wrapAsync(fboSuppliesController.deleteCargoUnit.bind(fboSuppliesController))
);

router.post('/:id/items', wrapAsync(fboSuppliesController.addSupplyItem.bind(fboSuppliesController)));
router.patch(
  '/:id/items/:itemId',
  wrapAsync(fboSuppliesController.updateSupplyItem.bind(fboSuppliesController))
);

router.get('/:id', wrapAsync(fboSuppliesController.getById.bind(fboSuppliesController)));
router.put('/:id', wrapAsync(fboSuppliesController.update.bind(fboSuppliesController)));
router.post('/:id/advance-status', wrapAsync(fboSuppliesController.advanceStatus.bind(fboSuppliesController)));
router.post(
  '/:id/sync-ozon-placement-zones',
  wrapAsync(fboSuppliesController.syncOzonPlacementZones.bind(fboSuppliesController))
);
router.post(
  '/:id/sync-marketplace-content',
  wrapAsync(fboSuppliesController.syncMarketplaceContent.bind(fboSuppliesController))
);
router.post(
  '/:id/pull-marketplace-content',
  wrapAsync(fboSuppliesController.pullMarketplaceContent.bind(fboSuppliesController))
);
router.post(
  '/:id/packing/submit',
  wrapAsync(fboSuppliesController.submitPackingToMarketplace.bind(fboSuppliesController))
);
router.delete('/:id', wrapAsync(fboSuppliesController.delete.bind(fboSuppliesController)));

export default router;
