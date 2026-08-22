/**
 * Products Routes
 * Маршруты для работы с товарами
 */

import express from 'express';
import productsController from '../controllers/products.controller.js';
import stockMovementsController from '../controllers/stockMovements.controller.js';
import productCompetitorsController from '../controllers/productCompetitors.controller.js';
import productEnrichmentController from '../controllers/productEnrichment.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth, requireProfileAdmin } from '../middleware/auth.js';
import { createProductImageUpload, createProductExcelImportUpload } from '../middleware/uploads.js';
import {
  validateCreateProduct,
  validateUpdateProduct,
  validateProductId,
} from '../validators/productValidator.js';

const router = express.Router();
const uploadProductImages = createProductImageUpload();
const uploadProductExcel = createProductExcelImportUpload();

// Принудительно обновить остатки и цены у поставщиков (должен быть ДО маршрута /:id)
// POST /api/products/refresh-supplier-stocks?productId=123 (опционально)
router.post(
  '/refresh-supplier-stocks',
  wrapAsync(productsController.refreshSupplierStocks.bind(productsController))
);
router.get(
  '/refresh-supplier-stocks/status',
  wrapAsync(productsController.refreshSupplierStocksStatus.bind(productsController))
);

// Статус модуля обогащения (до /:id)
router.get(
  '/enrichment/status',
  wrapAsync(productEnrichmentController.status.bind(productEnrichmentController))
);
router.post(
  '/enrichment/bulk',
  wrapAsync(productEnrichmentController.enrichBulk.bind(productEnrichmentController))
);
router.post(
  '/enrichment/create',
  wrapAsync(productEnrichmentController.createFromEnrichment.bind(productEnrichmentController))
);

// Обновить все товары (массовое обновление)
router.put(
  '/all/replace',
  wrapAsync(productsController.replaceAll.bind(productsController))
);

// Сводка остатков для главной (до /)
router.get(
  '/home-stock-summary',
  wrapAsync(productsController.getHomeStockSummary.bind(productsController))
);

// Получить все товары
router.get('/', wrapAsync(productsController.getAll.bind(productsController)));

// Экспорт в Excel (до /:id)
router.get('/export/excel', wrapAsync(productsController.exportExcel.bind(productsController)));

// Шаблон Excel для импорта (пустой лист «Товары» + «Словари»; опционально одна категория в справочнике)
router.get(
  '/import/template/excel',
  wrapAsync(productsController.downloadImportTemplateExcel.bind(productsController))
);

// Импорт из Excel (multipart, поле file)
router.post(
  '/import/excel',
  uploadProductExcel.single('file'),
  wrapAsync(productsController.importExcel.bind(productsController))
);

// Получить товар по штрихкоду (должен быть до /:id)
router.get(
  '/by-barcode/:barcode',
  wrapAsync(productsController.getByBarcode.bind(productsController))
);

router.get(
  '/marketplace-number-by-offer',
  wrapAsync(productsController.getMarketplaceNumberByOffer.bind(productsController))
);

// ID товаров по ERP-kategorии (до /:id)
router.get(
  '/grouped-by-user-category',
  wrapAsync(productsController.getProductIdsGroupedByUserCategory.bind(productsController))
);

router.get(
  '/distinct-user-category-ids',
  wrapAsync(productsController.getDistinctUserCategoryIds.bind(productsController))
);

// Получить товар по ID (с деталями: баркоды, SKU маркетплейсов, комплектующие)
router.get(
  '/:id',
  validateProductId,
  wrapAsync(productsController.getById.bind(productsController))
);

// Остаток товара на конкретном складе (инвентаризация, списание)
router.get(
  '/:id/warehouse-stock',
  validateProductId,
  wrapAsync(stockMovementsController.getWarehouseStock.bind(stockMovementsController))
);

// Получить историю движений остатков товара
router.get(
  '/:id/stock-movements',
  validateProductId,
  wrapAsync(stockMovementsController.getHistory.bind(stockMovementsController))
);

router.get(
  '/:id/stock-reserved-orders',
  validateProductId,
  wrapAsync(stockMovementsController.getReservedOrders.bind(stockMovementsController))
);

router.post(
  '/:id/stock-reserve-release-all',
  validateProductId,
  wrapAsync(stockMovementsController.releaseAllReserves.bind(stockMovementsController))
);

router.post(
  '/:id/stock-reserve-release-orphan',
  validateProductId,
  wrapAsync(stockMovementsController.releaseOrphanReserve.bind(stockMovementsController))
);

router.post(
  '/:id/stock-reserve-release-order',
  validateProductId,
  wrapAsync(stockMovementsController.releaseOrderReserve.bind(stockMovementsController))
);

// Изображения товара (должны быть ДО PUT /:id)
router.get(
  '/:id/images',
  validateProductId,
  wrapAsync(productsController.getImages.bind(productsController))
);
router.post(
  '/:id/images',
  validateProductId,
  uploadProductImages.array('images', 10),
  wrapAsync(productsController.uploadImages.bind(productsController))
);
router.put(
  '/:id/images',
  validateProductId,
  wrapAsync(productsController.updateImages.bind(productsController))
);
router.delete(
  '/:id/images/:imageId',
  validateProductId,
  wrapAsync(productsController.deleteImage.bind(productsController))
);
router.post(
  '/:id/images/from-marketplace/:marketplace',
  validateProductId,
  wrapAsync(productsController.importImagesFromMarketplace.bind(productsController))
);
router.post(
  '/:id/images/collapse-duplicates',
  validateProductId,
  wrapAsync(productsController.collapseImageDuplicates.bind(productsController))
);
router.post(
  '/:id/images/:imageId/fit-3x4',
  validateProductId,
  wrapAsync(productsController.fitImageAspect3x4.bind(productsController))
);
router.post(
  '/:id/images/:imageId/restore-3x4',
  validateProductId,
  wrapAsync(productsController.restoreImageAspect3x4.bind(productsController))
);

// Обогащение карточки (PartsAPI) — до PUT /:id
router.post(
  '/:id/enrich',
  validateProductId,
  wrapAsync(productEnrichmentController.enrich.bind(productEnrichmentController))
);

// Добавить товар (с валидацией)
router.post(
  '/',
  validateCreateProduct,
  wrapAsync(productsController.create.bind(productsController))
);

// Массовая отправка карточек на маркетплейсы (до /:id)
router.post('/push-card', wrapAsync(productsController.pushCardBulk.bind(productsController)));

// Массовое обновление карточек ERP данными с маркетплейсов (до /:id)
router.post('/pull-card', wrapAsync(productsController.pullCardBulk.bind(productsController)));

// Связать товар с карточкой маркетплейса по артикулу ERP (до PUT /:id)
router.post(
  '/:id/link-marketplace/:marketplace',
  validateProductId,
  wrapAsync(productsController.linkMarketplace.bind(productsController))
);

// Тестовая генерация Rich-контента из полей карточки (до PUT /:id)
router.post(
  '/:id/generate-rich-content',
  validateProductId,
  wrapAsync(productsController.generateRichContent.bind(productsController))
);
router.post(
  '/:id/generate-rich-content/:marketplace',
  validateProductId,
  wrapAsync(productsController.generateRichContent.bind(productsController))
);

// Отправить данные карточки на маркетплейс (до PUT /:id)
router.post(
  '/:id/push-card/:marketplace',
  validateProductId,
  wrapAsync(productsController.pushCard.bind(productsController))
);

// Обновить карточку ERP данными с маркетплейса (до PUT /:id)
router.post(
  '/:id/pull-card/:marketplace',
  validateProductId,
  wrapAsync(productsController.pullCard.bind(productsController))
);

// Только изображения с МП → галерея ERP
router.post(
  '/:id/pull-images/:marketplace',
  validateProductId,
  wrapAsync(productsController.pullImages.bind(productsController))
);

router.get(
  '/:id/participation',
  validateProductId,
  wrapAsync(productsController.getParticipation.bind(productsController))
);

router.get(
  '/:id/marketplace-number',
  validateProductId,
  wrapAsync(productsController.getMarketplaceNumber.bind(productsController))
);

// Конкуренты (ссылки на карточки МП)
router.get(
  '/:id/competitors',
  validateProductId,
  wrapAsync(productCompetitorsController.list.bind(productCompetitorsController))
);
router.post(
  '/:id/competitors',
  validateProductId,
  wrapAsync(productCompetitorsController.add.bind(productCompetitorsController))
);
router.delete(
  '/:id/competitors/:competitorId',
  validateProductId,
  wrapAsync(productCompetitorsController.remove.bind(productCompetitorsController))
);
router.post(
  '/:id/competitors/refresh',
  validateProductId,
  wrapAsync(productCompetitorsController.refresh.bind(productCompetitorsController))
);
router.post(
  '/:id/competitors/:competitorId/refresh',
  validateProductId,
  wrapAsync(productCompetitorsController.refresh.bind(productCompetitorsController))
);

router.post(
  '/:id/archive',
  validateProductId,
  wrapAsync(productsController.archive.bind(productsController))
);

router.post(
  '/:id/unarchive',
  validateProductId,
  wrapAsync(productsController.unarchive.bind(productsController))
);

// Обновить товар (с валидацией) - должен быть ПОСЛЕ всех специфических маршрутов
router.put(
  '/:id',
  validateProductId,
  validateUpdateProduct,
  wrapAsync(productsController.update.bind(productsController))
);

// Применить изменение остатка товара и записать движение
router.post(
  '/:id/stock-movements',
  validateProductId,
  wrapAsync(stockMovementsController.applyChange.bind(stockMovementsController))
);

// Перемещение товара между складами
router.post(
  '/:id/stock-transfer',
  requireAuth,
  validateProductId,
  wrapAsync(stockMovementsController.transfer.bind(stockMovementsController))
);

router.post(
  '/:id/stock-history-reset',
  requireAuth,
  requireProfileAdmin,
  validateProductId,
  wrapAsync(stockMovementsController.resetStockHistory.bind(stockMovementsController))
);

// Удалить товар (с валидацией ID) - должен быть ПОСЛЕ всех специфических маршрутов
router.delete(
  '/:id',
  validateProductId,
  wrapAsync(productsController.delete.bind(productsController))
);

export default router;


