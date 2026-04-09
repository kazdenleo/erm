/**
 * WB Marketplace Service
 * Сервис для обновления категорий и комиссий Wildberries из API
 */

import { query, transaction } from '../config/database.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import fetch from 'node-fetch';

class WBMarketplaceService {
  /**
   * Загрузить все категории WB из API
   */
  async loadCategoriesFromAPI(apiKey) {
    try {
      logger.info('[WB Marketplace] Loading categories from API...');
      
      const categories = [];
      let offset = 0;
      const limit = 1000;
      let hasMore = true;
      
      while (hasMore && offset < 100000) {
        const url = `https://content-api.wildberries.ru/content/v2/object/all?limit=${limit}&offset=${offset}`;
        
        logger.debug(`[WB Marketplace] Fetching categories: offset=${offset}, limit=${limit}`);
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': String(apiKey)
          },
          timeout: 15000
        });

        if (!response.ok) {
          logger.warn(`[WB Marketplace] API error: ${response.status} ${response.statusText}`);
          break;
        }

        const pageData = await response.json().catch(() => ({}));
        
        if (pageData.data && Array.isArray(pageData.data) && pageData.data.length > 0) {
          categories.push(...pageData.data);
          logger.debug(`[WB Marketplace] Loaded ${pageData.data.length} categories, total: ${categories.length}`);
          
          if (pageData.data.length < limit) {
            hasMore = false;
          } else {
            offset += limit;
            // Небольшая задержка между запросами
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          hasMore = false;
        }
      }
      
      logger.info(`[WB Marketplace] Total categories loaded: ${categories.length}`);
      return categories;
      
    } catch (error) {
      logger.error('[WB Marketplace] Error loading categories:', error);
      throw error;
    }
  }

  /**
   * Преобразовать категории WB в формат для БД
   */
  transformCategories(categoryList, parentPath = '', parentMarketplaceId = null) {
    const result = [];
    
    if (!Array.isArray(categoryList)) return result;
    
    categoryList.forEach(category => {
      const categoryName = category.name || category.subjectName;
      const categoryId = category.id || category.subjectID;
      const categoryParent = category.parent || category.parentID;
      const categoryParentName = category.parentName;
      
      if (categoryName && categoryName.trim()) {
        const currentPath = categoryParentName && !parentPath 
          ? `${categoryParentName} > ${categoryName.trim()}` 
          : (parentPath ? `${parentPath} > ${categoryName.trim()}` : categoryName.trim());
        
        result.push({
          marketplace_category_id: String(categoryId),
          name: categoryName.trim(),
          path: currentPath,
          parent_marketplace_id: parentMarketplaceId ? String(parentMarketplaceId) : null,
          marketplace: 'wb'
        });
        
        // Обрабатываем дочерние категории рекурсивно
        if (category.childs && Array.isArray(category.childs)) {
          const childResults = this.transformCategories(
            category.childs, 
            currentPath, 
            categoryId
          );
          result.push(...childResults);
        }
      }
    });
    
    return result;
  }

  /**
   * Сохранить категории в БД
   */
  async saveCategories(categories) {
    return await transaction(async (client) => {
      let saved = 0;
      let updated = 0;
      
      // Сначала создаем маппинг marketplace_category_id -> db_id для родительских категорий
      const categoryIdMap = new Map();
      
      // Проходим по категориям дважды: сначала создаем/обновляем все категории,
      // затем обновляем parent_id на основе маппинга
      for (const cat of categories) {
        // Проверяем, существует ли категория
        const existing = await client.query(
          `SELECT id FROM categories 
           WHERE marketplace = 'wb' AND marketplace_category_id = $1`,
          [cat.marketplace_category_id]
        );
        
        let dbId;
        if (existing.rows.length > 0) {
          dbId = existing.rows[0].id;
          // Обновляем существующую категорию (без parent_id пока)
          await client.query(
            `UPDATE categories 
             SET name = $1, path = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [cat.name, cat.path, dbId]
          );
          updated++;
        } else {
          // Создаем новую категорию (без parent_id пока)
          const result = await client.query(
            `INSERT INTO categories (marketplace, marketplace_category_id, name, path)
             VALUES ('wb', $1, $2, $3)
             RETURNING id`,
            [cat.marketplace_category_id, cat.name, cat.path]
          );
          dbId = result.rows[0].id;
          saved++;
        }
        
        categoryIdMap.set(cat.marketplace_category_id, dbId);
      }
      
      // Теперь обновляем parent_id для всех категорий
      for (const cat of categories) {
        if (cat.parent_marketplace_id) {
          const parentDbId = categoryIdMap.get(cat.parent_marketplace_id);
          if (parentDbId) {
            const dbId = categoryIdMap.get(cat.marketplace_category_id);
            await client.query(
              `UPDATE categories SET parent_id = $1 WHERE id = $2`,
              [parentDbId, dbId]
            );
          }
        }
      }
      
      logger.info(`[WB Marketplace] Categories saved: ${saved} new, ${updated} updated`);
      return { saved, updated, total: categories.length };
    });
  }

  /**
   * Загрузить комиссии WB из API
   */
  async loadCommissionsFromAPI(apiKey) {
    try {
      logger.info('[WB Marketplace] Loading commissions from API...');
      
      const response = await fetch('https://common-api.wildberries.ru/api/v1/tariffs/commission', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': String(apiKey)
        },
        timeout: 30000
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        logger.error(`[WB Marketplace] API error: ${response.status} ${errorText}`);
        throw new Error(`WB API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Структура ответа может быть разной, обрабатываем разные варианты
      let commissions = [];
      if (data.data && Array.isArray(data.data)) {
        commissions = data.data;
      } else if (data.report && Array.isArray(data.report)) {
        commissions = data.report;
      } else if (Array.isArray(data)) {
        commissions = data;
      }
      
      logger.info(`[WB Marketplace] Total commissions loaded: ${commissions.length}`);
      return commissions;
      
    } catch (error) {
      logger.error('[WB Marketplace] Error loading commissions:', error);
      throw error;
    }
  }

  /**
   * Сохранить комиссии в БД
   */
  async saveCommissions(commissions) {
    return await transaction(async (client) => {
      let saved = 0;
      let updated = 0;
      
      for (const comm of commissions) {
        // Логируем структуру данных из API для первых нескольких записей
        if (saved + updated < 3) {
          logger.info(`[WB Marketplace] Sample commission data structure:`, {
            allKeys: Object.keys(comm),
            subjectID: comm.subjectID,
            name: comm.name,
            kgvpMarketplace: comm.kgvpMarketplace,
            kgvpSupplier: comm.kgvpSupplier,
            commission: comm.commission,
            commissionPercent: comm.commissionPercent,
            fullData: JSON.stringify(comm, null, 2)
          });
        }
        
        // Извлекаем данные из ответа API (структура может отличаться)
        const categoryId = comm.subjectID || comm.categoryId || comm.category_id || comm.id;
        const categoryName = comm.subjectName || comm.name || comm.categoryName || comm.category_name;
        
        // Комиссии WB имеют разные значения для FBO и FBS
        // ИСПРАВЛЕНО: kgvpMarketplace - это FBS (Маркетплейс), а не FBO!
        const kgvpMarketplace = comm.kgvpMarketplace !== undefined ? comm.kgvpMarketplace : null; // FBS комиссия (Маркетплейс)
        const kgvpSupplier = comm.kgvpSupplier !== undefined ? comm.kgvpSupplier : null; // FBO/FBW комиссия (Склад WB)
        
        // Общая комиссия (если нет раздельных значений)
        const commissionPercent = comm.commission || comm.commissionPercent || comm.commission_percent || 
                                 (kgvpMarketplace !== null ? kgvpMarketplace : (kgvpSupplier !== null ? kgvpSupplier : 0));
        
        const minPrice = comm.minPrice || comm.min_price || null;
        const maxPrice = comm.maxPrice || comm.max_price || null;
        const deliveryPercent = comm.delivery || comm.deliveryPercent || comm.delivery_percent || null;
        const returnPercent = comm.return || comm.returnPercent || comm.return_percent || null;
        
        if (!categoryId) {
          logger.warn('[WB Marketplace] Skipping commission without categoryId:', comm);
          continue;
        }
        
        // Проверяем, существует ли комиссия
        const existing = await client.query(
          `SELECT id FROM wb_commissions WHERE category_id = $1`,
          [categoryId]
        );
        
        if (existing.rows.length > 0) {
          // Обновляем существующую комиссию
          await client.query(
            `UPDATE wb_commissions 
             SET category_name = $1, 
                 commission_percent = $2, 
                 min_price = $3, 
                 max_price = $4,
                 delivery_percent = $5,
                 return_percent = $6,
                 raw_data = $7,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $8`,
            [
              categoryName,
              commissionPercent,
              minPrice,
              maxPrice,
              deliveryPercent,
              returnPercent,
              JSON.stringify(comm), // Сохраняем полные данные включая kgvpMarketplace и kgvpSupplier
              existing.rows[0].id
            ]
          );
          updated++;
        } else {
          // Создаем новую комиссию
          await client.query(
            `INSERT INTO wb_commissions 
             (category_id, category_name, commission_percent, min_price, max_price, 
              delivery_percent, return_percent, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              categoryId,
              categoryName,
              commissionPercent,
              minPrice,
              maxPrice,
              deliveryPercent,
              returnPercent,
              JSON.stringify(comm) // Сохраняем полные данные включая kgvpMarketplace и kgvpSupplier
            ]
          );
          saved++;
        }
      }
      
      logger.info(`[WB Marketplace] Commissions saved: ${saved} new, ${updated} updated`);
      return { saved, updated, total: commissions.length };
    });
  }

  /**
   * Обновить категории и комиссии WB
   */
  async updateCategoriesAndCommissions() {
    try {
      logger.info('[WB Marketplace] Starting update of categories and commissions...');
      
      // Получаем конфигурацию WB
      const wbConfig = await integrationsService.getMarketplaceConfig('wildberries');
      if (!wbConfig || !wbConfig.api_key) {
        throw new Error('WB API key not configured');
      }
      
      // Загружаем и сохраняем категории
      const rawCategories = await this.loadCategoriesFromAPI(wbConfig.api_key);
      const transformedCategories = this.transformCategories(rawCategories);
      const categoriesResult = await this.saveCategories(transformedCategories);
      
      // Загружаем и сохраняем комиссии
      const commissions = await this.loadCommissionsFromAPI(wbConfig.api_key);
      const commissionsResult = await this.saveCommissions(commissions);
      
      logger.info('[WB Marketplace] Update completed successfully', {
        categories: categoriesResult,
        commissions: commissionsResult
      });
      
      return {
        success: true,
        categories: categoriesResult,
        commissions: commissionsResult
      };
      
    } catch (error) {
      logger.error('[WB Marketplace] Update failed:', error);
      throw error;
    }
  }

  /**
   * Получить комиссию по ID категории
   */
  async getCommissionByCategoryId(categoryId) {
    try {
      const result = await query(
        `SELECT * FROM wb_commissions WHERE category_id = $1`,
        [categoryId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('[WB Marketplace] Error getting commission:', error);
      throw error;
    }
  }

  /**
   * Получить все комиссии
   */
  async getAllCommissions() {
    try {
      const result = await query(
        `SELECT * FROM wb_commissions ORDER BY category_id`
      );
      
      return result.rows;
    } catch (error) {
      logger.error('[WB Marketplace] Error getting all commissions:', error);
      throw error;
    }
  }
}

export default new WBMarketplaceService();

