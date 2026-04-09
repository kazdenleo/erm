/**
 * User Categories Routes
 * Маршруты для работы с пользовательскими категориями
 */

import express from 'express';
import { wrapAsync } from '../middleware/errorHandler.js';
import userCategoriesController from '../controllers/user_categories.controller.js';

const router = express.Router();

// Получить все пользовательские категории
router.get('/', wrapAsync(userCategoriesController.getAll.bind(userCategoriesController)));

// Получить пользовательскую категорию по ID
router.get('/:id', wrapAsync(userCategoriesController.getById.bind(userCategoriesController)));

// Атрибуты маркетплейса по сопоставлению категории
router.get('/:id/marketplace-attributes', wrapAsync(userCategoriesController.getMarketplaceAttributes.bind(userCategoriesController)));

// Создать пользовательскую категорию
router.post('/', wrapAsync(userCategoriesController.create.bind(userCategoriesController)));

// Обновить пользовательскую категорию
router.put('/:id', wrapAsync(userCategoriesController.update.bind(userCategoriesController)));

// Удалить пользовательскую категорию
router.delete('/:id', wrapAsync(userCategoriesController.delete.bind(userCategoriesController)));

export default router;

