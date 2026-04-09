/**
 * Category Mappings Repository (PostgreSQL)
 * Репозиторий для работы с маппингами категорий в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class CategoryMappingsRepositoryPG {
  /**
   * Получить все маппинги
   */
  async findAll(options = {}) {
    const { productId, marketplace } = options;
    
    // Проверяем существование таблицы category_mappings
    let hasCategoryMappings = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'category_mappings'
        )
      `);
      hasCategoryMappings = tableCheck.rows[0]?.exists || false;
      if (!hasCategoryMappings) {
        console.warn('[Category Mappings Repository] Table category_mappings does not exist');
        return [];
      }
    } catch (err) {
      console.error('[Category Mappings Repository] Error checking table existence:', err);
      return [];
    }
    
    // Проверяем существование таблицы wb_commissions
    let hasWbCommissions = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wb_commissions'
        )
      `);
      hasWbCommissions = tableCheck.rows[0]?.exists || false;
    } catch (err) {
      // Если ошибка при проверке, предполагаем что таблицы нет
      hasWbCommissions = false;
    }
    
    // Упрощенный запрос, который работает даже без wb_commissions
    const wbCategoryName = hasWbCommissions 
      ? `(SELECT category_name FROM wb_commissions WHERE category_id = CAST(cm.category_id AS VARCHAR) LIMIT 1)`
      : `NULL`;
    
    // Упрощенный запрос для Ozon - просто ищем по точному совпадению
    // Приводим category_id к строке для сравнения
    const ozonCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ozon' 
      AND marketplace_category_id = CAST(cm.category_id AS VARCHAR)
      LIMIT 1
    )`;
    
    const ymCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ym' 
      AND marketplace_category_id = CAST(cm.category_id AS VARCHAR)
      LIMIT 1
    )`;
    
    try {
      // Упрощенный запрос без сложных подзапросов - сначала получаем базовые данные
      let sql = `
        SELECT 
          cm.*,
          p.sku as product_sku,
          p.name as product_name,
          'Unknown Category' as marketplace_category_name
        FROM category_mappings cm
        LEFT JOIN products p ON cm.product_id = p.id
        WHERE 1=1
      `;
      
      const params = [];
      let paramIndex = 1;
      
      if (productId) {
        // Нормализуем ID: извлекаем целую часть, если ID пришел как строка с десятичной частью
        const numericId = typeof productId === 'string' && productId.includes('.')
          ? parseInt(productId.split('.')[0], 10)
          : typeof productId === 'string'
          ? parseInt(productId, 10)
          : Math.floor(Number(productId));
        
        if (!isNaN(numericId) && numericId > 0) {
          sql += ` AND cm.product_id = $${paramIndex++}`;
          params.push(numericId);
        }
      }
      
      if (marketplace) {
        sql += ` AND cm.marketplace = $${paramIndex++}`;
        params.push(marketplace);
      }
      
      sql += ' ORDER BY cm.created_at DESC';
      
      console.log('[Category Mappings Repository] Executing SQL:', sql.substring(0, 200) + '...');
      console.log('[Category Mappings Repository] Params:', params);
      
      const result = await query(sql, params);
      console.log('[Category Mappings Repository] Query result:', result.rows.length, 'rows');
      return result.rows;
    } catch (error) {
      console.error('[Category Mappings Repository] SQL Error:', {
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint,
        position: error.position
      });
      throw error;
    }
  }
  
  /**
   * Получить маппинг по ID
   */
  async findById(id) {
    // Проверяем существование таблицы wb_commissions
    let hasWbCommissions = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wb_commissions'
        )
      `);
      hasWbCommissions = tableCheck.rows[0]?.exists || false;
    } catch (err) {
      hasWbCommissions = false;
    }
    
    const wbCategoryName = hasWbCommissions 
      ? `(SELECT category_name FROM wb_commissions WHERE category_id = cm.category_id LIMIT 1)`
      : `NULL`;
    
    // Для Ozon и YM получаем названия из таблицы categories по marketplace_category_id
    // Учитываем разные форматы ID (с префиксом "ozon_" или без)
    const ozonCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ozon' 
      AND cm.category_id IS NOT NULL
      AND (
        marketplace_category_id = cm.category_id 
        OR marketplace_category_id = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
        OR marketplace_category_id = ('ozon_' || COALESCE(cm.category_id, ''))
        OR REPLACE(COALESCE(marketplace_category_id, ''), 'ozon_', '') = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
      )
      LIMIT 1
    )`;
    const ymCategoryName = `(SELECT name FROM categories WHERE marketplace = 'ym' AND marketplace_category_id = cm.category_id LIMIT 1)`;
    
    const result = await query(`
      SELECT 
        cm.*,
        p.sku as product_sku,
        p.name as product_name,
        COALESCE(
          CASE 
            WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
            WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
            WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
            ELSE NULL
          END,
          'Unknown Category'
        ) as marketplace_category_name
      FROM category_mappings cm
      LEFT JOIN products p ON cm.product_id = p.id
      WHERE cm.id = $1
    `, [id]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить маппинг по продукту и маркетплейсу
   */
  async findByProductAndMarketplace(productId, marketplace) {
    // Нормализуем ID: извлекаем целую часть, если ID пришел как строка с десятичной частью
    const numericId = typeof productId === 'string' && productId.includes('.')
      ? parseInt(productId.split('.')[0], 10)
      : typeof productId === 'string'
      ? parseInt(productId, 10)
      : Math.floor(Number(productId));
    
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[Category Mappings Repository] Invalid productId: ${productId}`);
      return null;
    }
    
    // Проверяем существование таблицы wb_commissions
    let hasWbCommissions = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wb_commissions'
        )
      `);
      hasWbCommissions = tableCheck.rows[0]?.exists || false;
    } catch (err) {
      hasWbCommissions = false;
    }
    
    const wbCategoryName = hasWbCommissions 
      ? `(SELECT category_name FROM wb_commissions WHERE category_id = cm.category_id LIMIT 1)`
      : `NULL`;
    
    // Для Ozon и YM получаем названия из таблицы categories по marketplace_category_id
    // Учитываем разные форматы ID (с префиксом "ozon_" или без)
    const ozonCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ozon' 
      AND cm.category_id IS NOT NULL
      AND (
        marketplace_category_id = cm.category_id 
        OR marketplace_category_id = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
        OR marketplace_category_id = ('ozon_' || COALESCE(cm.category_id, ''))
        OR REPLACE(COALESCE(marketplace_category_id, ''), 'ozon_', '') = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
      )
      LIMIT 1
    )`;
    const ymCategoryName = `(SELECT name FROM categories WHERE marketplace = 'ym' AND marketplace_category_id = cm.category_id LIMIT 1)`;
    
    const result = await query(`
      SELECT 
        cm.*,
        p.sku as product_sku,
        p.name as product_name,
        COALESCE(
          CASE 
            WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
            WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
            WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
            ELSE NULL
          END,
          'Unknown Category'
        ) as marketplace_category_name
      FROM category_mappings cm
      LEFT JOIN products p ON cm.product_id = p.id
      WHERE cm.product_id = $1 AND cm.marketplace = $2
    `, [numericId, marketplace]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить маппинги по продукту
   */
  async findByProduct(productId) {
    // Нормализуем ID: извлекаем целую часть, если ID пришел как строка с десятичной частью
    const numericId = typeof productId === 'string' && productId.includes('.')
      ? parseInt(productId.split('.')[0], 10)
      : typeof productId === 'string'
      ? parseInt(productId, 10)
      : Math.floor(Number(productId));
    
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[Category Mappings Repository] Invalid productId: ${productId}`);
      return [];
    }
    
    console.log(`[Category Mappings Repository] Finding mappings for productId: ${numericId} (original: ${productId})`);
    
    // Сначала пробуем простой запрос без сложных подзапросов для диагностики
    try {
      const simpleTest = await query(`
        SELECT cm.*, p.sku as product_sku, p.name as product_name
        FROM category_mappings cm
        LEFT JOIN products p ON cm.product_id = p.id
        WHERE cm.product_id = $1
        LIMIT 1
      `, [numericId]);
      console.log(`[Category Mappings Repository] Simple query test: ${simpleTest.rows.length} rows`);
    } catch (simpleErr) {
      console.error(`[Category Mappings Repository] Simple query failed:`, simpleErr.message);
      // Если простой запрос не работает, значит проблема в типах колонки
      // Пробуем с явным приведением
      try {
        const castTest = await query(`
          SELECT cm.*, p.sku as product_sku, p.name as product_name
          FROM category_mappings cm
          LEFT JOIN products p ON CAST(cm.product_id AS BIGINT) = p.id
          WHERE CAST(cm.product_id AS BIGINT) = $1
          LIMIT 1
        `, [numericId]);
        console.log(`[Category Mappings Repository] CAST query test: ${castTest.rows.length} rows`);
      } catch (castErr) {
        console.error(`[Category Mappings Repository] CAST query also failed:`, castErr.message);
      }
    }
    
    // Проверяем существование таблицы wb_commissions
    let hasWbCommissions = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wb_commissions'
        )
      `);
      hasWbCommissions = tableCheck.rows[0]?.exists || false;
    } catch (err) {
      hasWbCommissions = false;
    }
    
    const wbCategoryName = hasWbCommissions 
      ? `(SELECT category_name FROM wb_commissions WHERE CAST(category_id AS TEXT) = CAST(cm.category_id AS TEXT) LIMIT 1)`
      : `NULL`;
    
    // Для Ozon и YM получаем названия из таблицы categories по marketplace_category_id
    // Учитываем разные форматы ID (с префиксом "ozon_" или без)
    // Приводим обе стороны к TEXT для безопасного сравнения
    const ozonCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ozon' 
      AND cm.category_id IS NOT NULL
      AND (
        CAST(marketplace_category_id AS TEXT) = CAST(cm.category_id AS TEXT)
        OR CAST(marketplace_category_id AS TEXT) = REPLACE(COALESCE(CAST(cm.category_id AS TEXT), ''), 'ozon_', '')
        OR CAST(marketplace_category_id AS TEXT) = ('ozon_' || COALESCE(CAST(cm.category_id AS TEXT), ''))
        OR REPLACE(COALESCE(CAST(marketplace_category_id AS TEXT), ''), 'ozon_', '') = REPLACE(COALESCE(CAST(cm.category_id AS TEXT), ''), 'ozon_', '')
      )
      LIMIT 1
    )`;
    const ymCategoryName = `(SELECT name FROM categories WHERE marketplace = 'ym' AND CAST(marketplace_category_id AS TEXT) = CAST(cm.category_id AS TEXT) LIMIT 1)`;
    
    // Исправляем проблему с типами: product_id определен как BIGINT в миграции
    // Используем простое сравнение, так как оба типа BIGINT
    // Если это не работает, значит тип колонки был изменен
    let result;
    try {
      // Пробуем простой запрос без приведения типов
      result = await query(`
        SELECT 
          cm.*,
          p.sku as product_sku,
          p.name as product_name,
          COALESCE(
            CASE 
              WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
              WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
              WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
              ELSE NULL
            END,
            'Unknown Category'
          ) as marketplace_category_name
        FROM category_mappings cm
        LEFT JOIN products p ON cm.product_id = p.id
        WHERE cm.product_id = $1
        ORDER BY cm.marketplace
      `, [numericId]);
    } catch (err) {
      // Если простой запрос не работает, используем приведение типов
      console.log(`[Category Mappings Repository] Simple query failed, trying with CAST:`, err.message);
      console.log(`[Category Mappings Repository] Error details:`, {
        message: err.message,
        code: err.code,
        detail: err.detail,
        hint: err.hint,
        position: err.position
      });
      try {
        result = await query(`
          SELECT 
            cm.*,
            p.sku as product_sku,
            p.name as product_name,
            COALESCE(
              CASE 
                WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
                WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
                WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
                ELSE NULL
              END,
              'Unknown Category'
            ) as marketplace_category_name
          FROM category_mappings cm
          LEFT JOIN products p ON CAST(CAST(cm.product_id AS TEXT) AS BIGINT) = p.id
          WHERE CAST(CAST(cm.product_id AS TEXT) AS BIGINT) = $1
          ORDER BY cm.marketplace
        `, [numericId]);
      } catch (castErr) {
        console.error(`[Category Mappings Repository] CAST query also failed:`, castErr.message);
        console.error(`[Category Mappings Repository] CAST error details:`, {
          message: castErr.message,
          code: castErr.code,
          detail: castErr.detail,
          hint: castErr.hint,
          position: castErr.position
        });
        // Если оба запроса не работают, пробуем запрос без подзапросов для названий категорий
        console.log(`[Category Mappings Repository] Trying query without category name subqueries...`);
        result = await query(`
          SELECT 
            cm.*,
            p.sku as product_sku,
            p.name as product_name,
            NULL as marketplace_category_name
          FROM category_mappings cm
          LEFT JOIN products p ON cm.product_id = p.id
          WHERE cm.product_id = $1
          ORDER BY cm.marketplace
        `, [numericId]);
      }
    }
    
    console.log(`[Category Mappings Repository] Query returned ${result.rows.length} mappings for productId ${numericId} (type: ${typeof numericId})`);
    if (result.rows.length > 0) {
      console.log(`[Category Mappings Repository] Sample mapping:`, {
        id: result.rows[0].id,
        product_id: result.rows[0].product_id,
        product_id_type: typeof result.rows[0].product_id,
        marketplace: result.rows[0].marketplace,
        category_id: result.rows[0].category_id,
        category_id_type: typeof result.rows[0].category_id
      });
    } else {
      console.warn(`[Category Mappings Repository] ⚠ No mappings found for productId ${numericId}. Checking if product exists...`);
      // Проверяем, существует ли товар
      const productCheck = await query(`SELECT id, sku, name FROM products WHERE id = $1`, [numericId]);
      if (productCheck.rows.length > 0) {
        console.log(`[Category Mappings Repository] Product exists:`, productCheck.rows[0]);
        // Проверяем, есть ли маппинги с другим типом product_id
        // Пробуем разные варианты приведения типов
        let altCheck = null;
        try {
          altCheck = await query(`SELECT * FROM category_mappings WHERE CAST(product_id AS BIGINT) = $1`, [numericId]);
          console.log(`[Category Mappings Repository] Alternative query (BIGINT) returned ${altCheck.rows.length} mappings`);
          if (altCheck.rows.length > 0) {
            console.log(`[Category Mappings Repository] Found mappings with BIGINT cast:`, altCheck.rows.map(r => ({
              id: r.id,
              product_id: r.product_id,
              marketplace: r.marketplace,
              category_id: r.category_id
            })));
          }
        } catch (err) {
          console.log(`[Category Mappings Repository] BIGINT cast failed, trying TEXT:`, err.message);
          try {
            altCheck = await query(`SELECT * FROM category_mappings WHERE CAST(product_id AS TEXT) = CAST($1 AS TEXT)`, [numericId]);
            console.log(`[Category Mappings Repository] Alternative query (TEXT) returned ${altCheck.rows.length} mappings`);
            if (altCheck.rows.length > 0) {
              console.log(`[Category Mappings Repository] Found mappings with TEXT cast:`, altCheck.rows.map(r => ({
                id: r.id,
                product_id: r.product_id,
                marketplace: r.marketplace,
                category_id: r.category_id
              })));
            }
          } catch (err2) {
            console.error(`[Category Mappings Repository] Both alternative queries failed:`, err2.message);
          }
        }
        // Проверяем все маппинги в таблице для отладки
        try {
          const allMappingsCheck = await query(`SELECT product_id, marketplace, category_id FROM category_mappings ORDER BY product_id LIMIT 20`);
          console.log(`[Category Mappings Repository] Sample of all mappings in table (first 20):`, allMappingsCheck.rows);
        } catch (err) {
          console.error(`[Category Mappings Repository] Failed to check all mappings:`, err.message);
        }
      } else {
        console.warn(`[Category Mappings Repository] Product ${numericId} does not exist in products table`);
      }
    }
    
    // Если маппинги не найдены напрямую, пробуем найти через категорию товара
    if (result.rows.length === 0) {
      console.log(`[Category Mappings Repository] No direct mappings found, trying to find via product's user_category_id...`);
      try {
        // Получаем user_category_id товара
        const productInfo = await query(`
          SELECT id, user_category_id 
          FROM products 
          WHERE id = $1
        `, [numericId]);
        
        if (productInfo.rows.length > 0 && productInfo.rows[0].user_category_id) {
          const userCategoryId = productInfo.rows[0].user_category_id;
          console.log(`[Category Mappings Repository] Product has user_category_id: ${userCategoryId}, searching for mappings via category...`);
          
          // Ищем маппинги для всех товаров этой категории
          const categoryMappings = await query(`
            SELECT DISTINCT ON (cm.marketplace)
              cm.*,
              p.sku as product_sku,
              p.name as product_name,
              COALESCE(
                CASE 
                  WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
                  WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
                  WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
                  ELSE NULL
                END,
                'Unknown Category'
              ) as marketplace_category_name
            FROM category_mappings cm
            LEFT JOIN products p ON CAST(CAST(cm.product_id AS TEXT) AS BIGINT) = p.id
            WHERE p.user_category_id = $1
            ORDER BY cm.marketplace, cm.id DESC
          `, [userCategoryId]);
          
          if (categoryMappings.rows.length > 0) {
            console.log(`[Category Mappings Repository] Found ${categoryMappings.rows.length} mappings via user_category_id ${userCategoryId}`);
            return categoryMappings.rows;
          }
        }
      } catch (err) {
        console.error(`[Category Mappings Repository] Error finding mappings via category:`, err);
      }
    }
    
    return result.rows;
  }
  
  /**
   * Получить маппинги по маркетплейсу
   */
  async findByMarketplace(marketplace) {
    // Проверяем существование таблицы wb_commissions
    let hasWbCommissions = false;
    try {
      const tableCheck = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wb_commissions'
        )
      `);
      hasWbCommissions = tableCheck.rows[0]?.exists || false;
    } catch (err) {
      hasWbCommissions = false;
    }
    
    const wbCategoryName = hasWbCommissions 
      ? `(SELECT category_name FROM wb_commissions WHERE category_id = cm.category_id LIMIT 1)`
      : `NULL`;
    
    // Для Ozon и YM получаем названия из таблицы categories по marketplace_category_id
    // Учитываем разные форматы ID (с префиксом "ozon_" или без)
    const ozonCategoryName = `(
      SELECT name FROM categories 
      WHERE marketplace = 'ozon' 
      AND cm.category_id IS NOT NULL
      AND (
        marketplace_category_id = cm.category_id 
        OR marketplace_category_id = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
        OR marketplace_category_id = ('ozon_' || COALESCE(cm.category_id, ''))
        OR REPLACE(COALESCE(marketplace_category_id, ''), 'ozon_', '') = REPLACE(COALESCE(cm.category_id, ''), 'ozon_', '')
      )
      LIMIT 1
    )`;
    const ymCategoryName = `(SELECT name FROM categories WHERE marketplace = 'ym' AND marketplace_category_id = cm.category_id LIMIT 1)`;
    
    const result = await query(`
      SELECT 
        cm.*,
        p.sku as product_sku,
        p.name as product_name,
        COALESCE(
          CASE 
            WHEN cm.marketplace = 'wb' THEN ${wbCategoryName}
            WHEN cm.marketplace = 'ozon' THEN ${ozonCategoryName}
            WHEN cm.marketplace = 'ym' THEN ${ymCategoryName}
            ELSE NULL
          END,
          'Unknown Category'
        ) as marketplace_category_name
      FROM category_mappings cm
      LEFT JOIN products p ON cm.product_id = p.id
      WHERE cm.marketplace = $1
      ORDER BY cm.created_at DESC
    `, [marketplace]);
    
    return result.rows;
  }
  
  /**
   * Создать маппинг
   */
  async create(mappingData) {
    // category_id может быть строкой (для Ozon это description_category_id) или числом (для WB)
    // В таблице category_id имеет тип VARCHAR(255), поэтому всегда преобразуем в строку
    const categoryId = String(mappingData.category_id || '');
    
    if (!categoryId || categoryId === 'undefined' || categoryId === 'null') {
      throw new Error('category_id не может быть пустым');
    }
    
    const result = await query(`
      INSERT INTO category_mappings (product_id, marketplace, category_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [
      mappingData.product_id,
      mappingData.marketplace,
      categoryId
    ]);
    
    return result.rows[0];
  }
  
  /**
   * Обновить маппинг
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = ['product_id', 'marketplace', 'category_id'];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        updateFields.push(`${field} = $${paramIndex++}`);
        // Для category_id всегда преобразуем в строку (VARCHAR в БД)
        if (field === 'category_id') {
          const categoryIdStr = String(updates[field] || '');
          if (!categoryIdStr || categoryIdStr === 'undefined' || categoryIdStr === 'null') {
            throw new Error('category_id не может быть пустым');
          }
          params.push(categoryIdStr);
        } else {
          params.push(updates[field]);
        }
      }
    }
    
    if (updateFields.length === 0) {
      return await this.findById(id);
    }
    
    params.push(id);
    const result = await query(`
      UPDATE category_mappings 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить маппинг
   */
  async delete(id) {
    const result = await query('DELETE FROM category_mappings WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  
  /**
   * Удалить маппинг по продукту и маркетплейсу
   */
  async deleteByProductAndMarketplace(productId, marketplace) {
    // Нормализуем ID: извлекаем целую часть, если ID пришел как строка с десятичной частью
    const numericId = typeof productId === 'string' && productId.includes('.')
      ? parseInt(productId.split('.')[0], 10)
      : typeof productId === 'string'
      ? parseInt(productId, 10)
      : Math.floor(Number(productId));
    
    if (isNaN(numericId) || numericId <= 0) {
      console.warn(`[Category Mappings Repository] Invalid productId: ${productId}`);
      return false;
    }
    
    const result = await query(
      'DELETE FROM category_mappings WHERE product_id = $1 AND marketplace = $2 RETURNING id',
      [numericId, marketplace]
    );
    return result.rows.length > 0;
  }
}

export default new CategoryMappingsRepositoryPG();

