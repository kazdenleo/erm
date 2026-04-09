/**
 * Suppliers Repository (PostgreSQL)
 * Репозиторий для работы с поставщиками в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class SuppliersRepositoryPG {
  /**
   * Получить всех поставщиков
   */
  async findAll(options = {}) {
    const { isActive } = options;
    
    let sql = 'SELECT * FROM suppliers WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (isActive !== undefined) {
      sql += ` AND is_active = $${paramIndex++}`;
      params.push(isActive);
    }
    
    sql += ' ORDER BY name';
    
    const result = await query(sql, params);
    console.log('[SuppliersRepository] findAll - raw rows count:', result.rows.length);
    
    // Парсим JSONB поле api_config и преобразуем в camelCase
    const mapped = result.rows.map(row => {
      let apiConfig = {};
      try {
        if (row.api_config) {
          apiConfig = typeof row.api_config === 'string' 
            ? JSON.parse(row.api_config) 
            : row.api_config;
        }
      } catch (e) {
        console.error('[SuppliersRepository] Error parsing api_config:', e);
      }
      
      // Удаляем snake_case поля, оставляем только camelCase
      const { api_config, is_active, ...rest } = row;
      const supplier = {
        id: rest.id,
        name: rest.name,
        code: rest.code,
        created_at: rest.created_at,
        updated_at: rest.updated_at,
        apiConfig: apiConfig,
        isActive: row.is_active
      };
      
      return supplier;
    });
    
    console.log('[SuppliersRepository] findAll - mapped count:', mapped.length);
    return mapped;
  }
  
  /**
   * Получить поставщика по ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM suppliers WHERE id = $1', [id]);
    if (!result.rows[0]) {
      return null;
    }
    
    const row = result.rows[0];
    let apiConfig = {};
    try {
      if (row.api_config) {
        apiConfig = typeof row.api_config === 'string' 
          ? JSON.parse(row.api_config) 
          : row.api_config;
      }
    } catch (e) {
      console.error('[SuppliersRepository] Error parsing api_config:', e);
    }
    
    return {
      ...row,
      apiConfig: apiConfig,
      isActive: row.is_active
    };
  }
  
  /**
   * Получить поставщика по коду
   */
  async findByCode(code) {
    const result = await query('SELECT * FROM suppliers WHERE code = $1', [code]);
    if (!result.rows[0]) {
      return null;
    }
    
    const row = result.rows[0];
    let apiConfig = {};
    try {
      if (row.api_config) {
        apiConfig = typeof row.api_config === 'string' 
          ? JSON.parse(row.api_config) 
          : row.api_config;
      }
    } catch (e) {
      console.error('[SuppliersRepository] Error parsing api_config:', e);
    }
    
    return {
      ...row,
      apiConfig: apiConfig,
      isActive: row.is_active
    };
  }
  
  /**
   * Создать поставщика
   */
  async create(supplierData) {
    const result = await query(`
      INSERT INTO suppliers (name, code, api_config, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [
      supplierData.name,
      supplierData.code,
      JSON.stringify(supplierData.api_config || supplierData.apiConfig || {}),
      supplierData.is_active !== undefined ? supplierData.is_active : (supplierData.isActive !== undefined ? supplierData.isActive : true)
    ]);
    
    const row = result.rows[0];
    let apiConfig = {};
    try {
      if (row.api_config) {
        apiConfig = typeof row.api_config === 'string' 
          ? JSON.parse(row.api_config) 
          : row.api_config;
      }
    } catch (e) {
      console.error('[SuppliersRepository] Error parsing api_config:', e);
    }
    
    return {
      ...row,
      apiConfig: apiConfig,
      isActive: row.is_active
    };
  }
  
  /**
   * Обновить поставщика
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = ['name', 'code', 'api_config', 'is_active'];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        if (field === 'api_config') {
          updateFields.push(`${field} = $${paramIndex++}`);
          params.push(JSON.stringify(updates[field]));
        } else {
          updateFields.push(`${field} = $${paramIndex++}`);
          params.push(updates[field]);
        }
      }
    }
    
    if (updateFields.length === 0) {
      return await this.findById(id);
    }
    
    params.push(id);
    const result = await query(`
      UPDATE suppliers 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    if (!result.rows[0]) {
      return null;
    }
    
    const row = result.rows[0];
    let apiConfig = {};
    try {
      if (row.api_config) {
        apiConfig = typeof row.api_config === 'string' 
          ? JSON.parse(row.api_config) 
          : row.api_config;
      }
    } catch (e) {
      console.error('[SuppliersRepository] Error parsing api_config:', e);
    }
    
    return {
      ...row,
      apiConfig: apiConfig,
      isActive: row.is_active
    };
  }
  
  /**
   * Удалить поставщика
   */
  async delete(id) {
    const result = await query('DELETE FROM suppliers WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  
  /**
   * Получить остатки поставщика для товара
   */
  async getProductStock(supplierId, productId) {
    const result = await query(`
      SELECT * FROM supplier_stocks
      WHERE supplier_id = $1 AND product_id = $2
    `, [supplierId, productId]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Обновить остатки поставщика
   */
  async updateProductStock(supplierId, productId, stockData) {
    const result = await query(`
      INSERT INTO supplier_stocks (
        supplier_id, product_id, stock, price, delivery_days,
        stock_name, source, warehouses, cached_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (supplier_id, product_id) 
      DO UPDATE SET
        stock = EXCLUDED.stock,
        price = EXCLUDED.price,
        delivery_days = EXCLUDED.delivery_days,
        stock_name = EXCLUDED.stock_name,
        source = EXCLUDED.source,
        warehouses = EXCLUDED.warehouses,
        cached_at = EXCLUDED.cached_at,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      supplierId,
      productId,
      stockData.stock || 0,
      stockData.price || null,
      stockData.delivery_days || 0,
      stockData.stock_name || null,
      stockData.source || 'api',
      stockData.warehouses ? JSON.stringify(stockData.warehouses) : null,
      stockData.cached_at || new Date()
    ]);
    
    return result.rows[0];
  }
}

export default new SuppliersRepositoryPG();

