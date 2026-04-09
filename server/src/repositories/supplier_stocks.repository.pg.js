/**
 * Supplier Stocks Repository (PostgreSQL)
 * Репозиторий для работы с остатками поставщиков в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class SupplierStocksRepositoryPG {
  /**
   * Получить все остатки
   */
  async findAll(options = {}) {
    const { supplierId, productId, minStock } = options;
    
    let sql = `
      SELECT 
        ss.*,
        s.name as supplier_name,
        s.code as supplier_code,
        p.sku as product_sku,
        p.name as product_name
      FROM supplier_stocks ss
      LEFT JOIN suppliers s ON ss.supplier_id = s.id
      LEFT JOIN products p ON ss.product_id = p.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (supplierId) {
      sql += ` AND ss.supplier_id = $${paramIndex++}`;
      params.push(supplierId);
    }
    
    if (productId) {
      sql += ` AND ss.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    
    if (minStock !== undefined) {
      sql += ` AND ss.stock >= $${paramIndex++}`;
      params.push(minStock);
    }
    
    sql += ' ORDER BY ss.cached_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Получить остаток по ID
   */
  async findById(id) {
    const result = await query(`
      SELECT 
        ss.*,
        s.name as supplier_name,
        s.code as supplier_code,
        p.sku as product_sku,
        p.name as product_name
      FROM supplier_stocks ss
      LEFT JOIN suppliers s ON ss.supplier_id = s.id
      LEFT JOIN products p ON ss.product_id = p.id
      WHERE ss.id = $1
    `, [id]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить остаток по поставщику и товару
   */
  async findBySupplierAndProduct(supplierId, productId) {
    const result = await query(`
      SELECT 
        ss.*,
        s.name as supplier_name,
        s.code as supplier_code,
        p.sku as product_sku,
        p.name as product_name
      FROM supplier_stocks ss
      LEFT JOIN suppliers s ON ss.supplier_id = s.id
      LEFT JOIN products p ON ss.product_id = p.id
      WHERE ss.supplier_id = $1 AND ss.product_id = $2
    `, [supplierId, productId]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить остатки по SKU товара
   */
  async findByProductSku(sku) {
    const result = await query(`
      SELECT 
        ss.*,
        s.name as supplier_name,
        s.code as supplier_code,
        p.sku as product_sku,
        p.name as product_name
      FROM supplier_stocks ss
      LEFT JOIN suppliers s ON ss.supplier_id = s.id
      LEFT JOIN products p ON ss.product_id = p.id
      WHERE p.sku = $1
      ORDER BY ss.stock DESC, ss.price ASC
    `, [sku]);
    
    return result.rows;
  }

  /**
   * Получить остатки по поставщику
   */
  async findBySupplier(supplierId) {
    const result = await query(`
      SELECT 
        ss.*,
        s.name as supplier_name,
        s.code as supplier_code,
        p.sku as product_sku,
        p.name as product_name
      FROM supplier_stocks ss
      LEFT JOIN suppliers s ON ss.supplier_id = s.id
      LEFT JOIN products p ON ss.product_id = p.id
      WHERE ss.supplier_id = $1
      ORDER BY ss.cached_at DESC
    `, [supplierId]);
    
    return result.rows;
  }
  
  /**
   * Создать или обновить остаток
   */
  async upsert(stockData) {
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
      stockData.supplier_id,
      stockData.product_id,
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
  
  /**
   * Обновить остаток
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = [
      'stock', 'price', 'delivery_days', 'stock_name', 
      'source', 'warehouses', 'cached_at'
    ];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        if (field === 'warehouses') {
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
      UPDATE supplier_stocks 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить остаток
   */
  async delete(id) {
    const result = await query('DELETE FROM supplier_stocks WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  
  /**
   * Очистить устаревшие кэши
   */
  async clearOldCache(maxAgeHours = 24) {
    const result = await query(`
      DELETE FROM supplier_stocks
      WHERE cached_at < NOW() - INTERVAL '${maxAgeHours} hours'
      AND source = 'cache'
      RETURNING id
    `);
    
    return result.rows.length;
  }

  /**
   * Удалить устаревшие кэши (по дате)
   */
  async deleteOldCache(maxAgeDate) {
    const result = await query(`
      DELETE FROM supplier_stocks
      WHERE cached_at < $1
      AND source = 'cache'
      RETURNING id
    `, [maxAgeDate]);
    
    return result.rows.length;
  }
}

export default new SupplierStocksRepositoryPG();

