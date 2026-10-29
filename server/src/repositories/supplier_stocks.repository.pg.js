/**
 * Supplier Stocks Repository (PostgreSQL)
 * Репозиторий для работы с остатками поставщиков в PostgreSQL
 */

import { query, transaction } from '../config/database.js';
import { sumOrderableSupplierWarehouseStock } from '../utils/supplierProcurementArrival.js';
import { resolveSupplierWarehouseNameForMainWarehouse } from '../utils/citySupplierWarehouse.js';

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
   * Разбивка остатков по поставщикам для списка товаров (из кэша supplier_stocks).
   * @param {number[]} productIds
   * @param {{ mainWarehouseId?: string|number|null, profileId?: string|number|null }} [options]
   * @returns {Promise<Array>}
   */
  async findBreakdownByProductIds(productIds, options = {}) {
    const ids = (Array.isArray(productIds) ? productIds : [])
      .map((id) => (typeof id === 'string' ? parseInt(id, 10) : Number(id)))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return [];

    const mainWarehouseId =
      options.mainWarehouseId != null && String(options.mainWarehouseId).trim() !== ''
        ? String(options.mainWarehouseId).trim()
        : null;
    const profileId =
      options.profileId != null && String(options.profileId).trim() !== ''
        ? String(options.profileId).trim()
        : null;

    const params = [ids];
    let warehouseFilterSql = `
      AND EXISTS (
        SELECT 1 FROM warehouses w
        WHERE w.supplier_id = s.id
          AND w.type = 'supplier'
          AND w.main_warehouse_id IS NOT NULL`;

    if (mainWarehouseId) {
      params.push(mainWarehouseId);
      warehouseFilterSql += `
          AND (
            w.main_warehouse_id = $${params.length}
            OR EXISTS (
              SELECT 1 FROM supplier_warehouse_main_links l
              WHERE l.supplier_warehouse_id = w.id AND l.main_warehouse_id = $${params.length}
            )
          )`;
    }
    if (profileId) {
      params.push(profileId);
      warehouseFilterSql += `
          AND (w.profile_id = $${params.length} OR w.profile_id IS NULL)`;
    }
    warehouseFilterSql += `
      )`;

    const reservedRes = await query(
      `SELECT pu.supplier_id, pi.product_id,
              SUM(GREATEST(0, COALESCE(pi.expected_quantity, 0) - COALESCE(pi.received_quantity, 0)))::int AS reserved
         FROM purchase_items pi
         INNER JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pi.product_id = ANY($1::int[])
          AND pu.supplier_id IS NOT NULL
          AND LOWER(TRIM(COALESCE(pu.status, ''))) = 'open'
        GROUP BY pu.supplier_id, pi.product_id`,
      [ids]
    );
    const reservedByKey = new Map();
    for (const row of reservedRes.rows || []) {
      reservedByKey.set(`${row.supplier_id}:${row.product_id}`, Number(row.reserved) || 0);
    }

    const result = await query(
      `SELECT
         ss.product_id,
         ss.stock,
         ss.price,
         ss.delivery_days,
         ss.stock_name,
         ss.warehouses,
         s.id AS supplier_id,
         s.name AS supplier_name,
         s.code AS supplier_code,
         s.api_config
       FROM supplier_stocks ss
       JOIN suppliers s ON ss.supplier_id = s.id
       WHERE ss.product_id = ANY($1::int[])
         AND COALESCE(ss.stock, 0) > 0
         ${warehouseFilterSql}
       ORDER BY ss.product_id, s.name NULLS LAST`,
      params
    );
    const now = new Date();
    const cityHintBySupplier = new Map();
    if (mainWarehouseId) {
      const supplierIds = [
        ...new Set(
          (result.rows || [])
            .map((row) => Number(row.supplier_id))
            .filter((id) => Number.isFinite(id) && id > 0)
        ),
      ];
      await Promise.all(
        supplierIds.map(async (sid) => {
          const hint = await resolveSupplierWarehouseNameForMainWarehouse(mainWarehouseId, sid, {
            profileId,
          });
          if (hint) cityHintBySupplier.set(sid, hint);
        })
      );
    }

    return (result.rows || [])
      .map((row) => {
        const sid = Number(row.supplier_id);
        const warehouseNameHint = cityHintBySupplier.get(sid) || null;
        const orderable = sumOrderableSupplierWarehouseStock({
          apiConfig: row.api_config,
          stockWarehouses: row.warehouses,
          aggregatedStock: row.stock,
          now,
          warehouseNameHint,
        });
        const reserved = reservedByKey.get(`${row.supplier_id}:${row.product_id}`) || 0;
        return {
          product_id: row.product_id,
          stock: Math.max(0, orderable - reserved),
          price: row.price,
          delivery_days: row.delivery_days,
          stock_name: row.stock_name,
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name,
          supplier_code: row.supplier_code,
          warehouse_name_hint: warehouseNameHint,
        };
      })
      .filter((row) => (Number(row.stock) || 0) > 0);
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

