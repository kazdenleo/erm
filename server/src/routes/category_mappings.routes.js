/**
 * Category Mappings Routes
 * Маршруты для работы с маппингами категорий
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import categoryMappingsController from '../controllers/category_mappings.controller.js';

const router = express.Router();

// Middleware для логирования всех запросов к category-mappings
router.use((req, res, next) => {
  console.log('[Category Mappings Route] ========================================');
  console.log('[Category Mappings Route] Request:', {
    method: req.method,
    url: req.url,
    path: req.path,
    params: req.params,
    query: req.query,
    headers: {
      'if-none-match': req.headers['if-none-match'],
      'if-modified-since': req.headers['if-modified-since'],
      'cache-control': req.headers['cache-control']
    }
  });
  console.log('[Category Mappings Route] ========================================');
  next();
});

// Получить все маппинги
router.get('/', wrapAsync(categoryMappingsController.getAll.bind(categoryMappingsController)));

// Получить маппинги по товару
router.get('/product/:productId', wrapAsync(categoryMappingsController.getByProduct.bind(categoryMappingsController)));

// Получить маппинг по ID
router.get('/:id', wrapAsync(categoryMappingsController.getById.bind(categoryMappingsController)));

// Создать маппинг
router.post('/', wrapAsync(categoryMappingsController.create.bind(categoryMappingsController)));

// Обновить маппинг
router.put('/:id', wrapAsync(categoryMappingsController.update.bind(categoryMappingsController)));

// Удалить маппинг
router.delete('/:id', wrapAsync(categoryMappingsController.delete.bind(categoryMappingsController)));

export default router;

