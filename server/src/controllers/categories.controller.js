/**
 * Categories Controller
 * Контроллер для управления категориями
 */

import repositoryFactory from '../config/repository-factory.js';
import integrationsService from '../services/integrations.service.js';

const categoriesRepository = repositoryFactory.getCategoriesRepository();

export const categoriesController = {
  async getAll(req, res, next) {
    try {
      const { marketplace } = req.query;
      
      // Для Яндекс.Маркета используем категории из integrations (API + БД, обновляются раз в день)
      if (marketplace === 'ym' || marketplace === 'yandex') {
        try {
          const ymCategories = await integrationsService.getYandexCategories();
          const formattedCategories = (ymCategories || []).map(cat => ({
            id: cat.id,
            name: cat.name,
            marketplace_category_id: cat.id,
            marketplace: 'ym',
            parent_id: cat.parent_id,
            path: cat.path || cat.name
          }));
          return res.json({ ok: true, data: formattedCategories });
        } catch (error) {
          console.warn('[Categories Controller] Error loading Yandex categories:', error);
          return res.json({ ok: true, data: [] });
        }
      }

      // Для WB используем категории из комиссий вместо таблицы categories
      if (marketplace === 'wb' || marketplace === 'wildberries') {
        try {
          const wbCategories = await integrationsService.getWildberriesCategories();
          // Преобразуем формат для совместимости с фронтендом
          // subjectID будет использоваться как category_id при создании маппинга
          const formattedCategories = wbCategories.map(cat => ({
            id: cat.subjectID, // Используем subjectID как id для маппинга
            name: cat.subjectName,
            marketplace_category_id: cat.subjectID,
            marketplace: 'wb',
            parent_id: cat.parentID,
            parent_name: cat.parentName
          }));
          return res.json({ ok: true, data: formattedCategories });
        } catch (error) {
          // Если не удалось загрузить из комиссий, возвращаем пустой массив
          console.warn('[Categories Controller] Error loading WB categories from commissions:', error);
          return res.json({ ok: true, data: [] });
        }
      }
      
      const categories = await categoriesRepository.findAll({ marketplace });
      res.json({ ok: true, data: categories });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const category = await categoriesRepository.findById(id);
      if (!category) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      res.json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const categoryData = req.body;
      const category = await categoriesRepository.create(categoryData);
      res.status(201).json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const updates = req.body;
      const category = await categoriesRepository.update(id, updates);
      if (!category) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      res.json({ ok: true, data: category });
    } catch (error) {
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const deleted = await categoriesRepository.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Категория не найдена' });
      }
      res.json({ ok: true, message: 'Категория удалена' });
    } catch (error) {
      next(error);
    }
  }
};

