/**
 * Categories API Service
 * Сервис для работы с категориями через API
 */

import api from './api.js';
import { integrationsApi } from './integrations.api.js';

export const categoriesApi = {
  async getAll(marketplace = null) {
    // Для WB используем категории из комиссий
    if (marketplace === 'wb' || marketplace === 'wildberries') {
      try {
        const response = await integrationsApi.getWildberriesCategories();
        // Преобразуем формат для совместимости
        const formattedCategories = (response.data || []).map(cat => ({
          id: cat.subjectID, // Используем subjectID как id для маппинга
          name: cat.subjectName,
          marketplace_category_id: cat.subjectID,
          marketplace: 'wb',
          parent_id: cat.parentID,
          parent_name: cat.parentName
        }));
        return { ok: true, data: formattedCategories };
      } catch (error) {
        console.error('[Categories API] Error loading WB categories from commissions:', error);
        return { ok: true, data: [] };
      }
    }
    
    // Для Яндекс.Маркета загружаем категории через integrations API (только из БД для быстрой загрузки)
    if (marketplace === 'ym' || marketplace === 'yandex') {
      try {
        const response = await integrationsApi.getYandexCategories({ dbOnly: true });
        const ymCategories = response?.data || [];
        const formattedCategories = ymCategories.map(cat => ({
          id: cat.id,
          name: cat.name,
          path: cat.path,
          marketplace_category_id: cat.id,
          marketplace: 'ym',
          parent_id: cat.parent_id
        }));
        return { ok: true, data: formattedCategories };
      } catch (error) {
        console.error('[Categories API] Error loading Yandex categories:', error);
        return { ok: true, data: [] };
      }
    }

    // Для Ozon — только из БД (список обновляется 1 раз ночью)
    if (marketplace === 'ozon') {
      try {
        const response = await integrationsApi.getOzonCategories({ dbOnly: true });
        // Преобразуем формат для совместимости
        const ozonCategories = response.data || [];
        const formattedCategories = ozonCategories.map(cat => ({
          id: cat.id,
          name: cat.name,
          path: cat.path,
          marketplace_category_id: cat.id,
          marketplace: 'ozon',
          parent_id: cat.parent_id,
          disabled: cat.disabled,
          description_category_id: cat.description_category_id,
          type_id: cat.type_id
        }));
        return { ok: true, data: formattedCategories };
      } catch (error) {
        console.error('[Categories API] Error loading Ozon categories:', error);
        return { ok: true, data: [] };
      }
    }
    
    const params = marketplace ? { marketplace } : {};
    const response = await api.get('/categories', { params });
    return response.data;
  },

  async getById(id) {
    const response = await api.get(`/categories/${id}`);
    return response.data;
  },

  async create(categoryData) {
    const response = await api.post('/categories', categoryData);
    return response.data;
  },

  async update(id, updates) {
    const response = await api.put(`/categories/${id}`, updates);
    return response.data;
  },

  async delete(id) {
    const response = await api.delete(`/categories/${id}`);
    return response.data;
  }
};

