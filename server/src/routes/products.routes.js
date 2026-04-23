/**
 * Products Routes
 * Маршруты для работы с товарами
 */

import express from 'express';
import productsController from '../controllers/products.controller.js';
import stockMovementsController from '../controllers/stockMovements.controller.js';
import { wrapAsync } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
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
router.post('/refresh-supplier-stocks', (req, res, next) => {
  console.log('[Products Routes] POST /refresh-supplier-stocks called');
  console.log('[Products Routes] Query params:', req.query);
  console.log('[Products Routes] Body:', req.body);
  wrapAsync(productsController.refreshSupplierStocks.bind(productsController))(req, res, next);
});

// Обновить все товары (массовое обновление)
router.put(
  '/all/replace',
  wrapAsync(productsController.replaceAll.bind(productsController))
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

// ID товаров по ERP-категории (до /:id)
router.get(
  '/grouped-by-user-category',
  wrapAsync(productsController.getProductIdsGroupedByUserCategory.bind(productsController))
);

// Получить товар по ID (с деталями: баркоды, SKU маркетплейсов, комплектующие)
router.get(
  '/:id',
  validateProductId,
  wrapAsync(productsController.getById.bind(productsController))
);

// Получить историю движений остатков товара
router.get(
  '/:id/stock-movements',
  validateProductId,
  wrapAsync(stockMovementsController.getHistory.bind(stockMovementsController))
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

// Добавить товар (с валидацией)
router.post(
  '/',
  validateCreateProduct,
  wrapAsync(productsController.create.bind(productsController))
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

// Удалить товар (с валидацией ID) - должен быть ПОСЛЕ всех специфических маршрутов
router.delete(
  '/:id',
  validateProductId,
  wrapAsync(productsController.delete.bind(productsController))
);

export default router;


