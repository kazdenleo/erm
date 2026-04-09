/**
 * Warehouse Mappings Repository (PostgreSQL)
 * Репозиторий для работы с маппингами складов в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class WarehouseMappingsRepositoryPG {
  /**
   * Получить все маппинги
   */
  async findAll(options = {}) {
    const { warehouseId, marketplace } = options;
    
    let sql = `
      SELECT 
        wm.*,
        w.address as warehouse_address,
        w.type as warehouse_type
      FROM warehouse_mappings wm
      LEFT JOIN warehouses w ON wm.warehouse_id = w.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (warehouseId) {
      sql += ` AND wm.warehouse_id = $${paramIndex++}`;
      params.push(warehouseId);
    }
    
    if (marketplace) {
      sql += ` AND wm.marketplace = $${paramIndex++}`;
      params.push(marketplace);
    }
    
    sql += ' ORDER BY wm.created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Получить маппинг по ID
   */
  async findById(id) {
    const result = await query(`
      SELECT 
        wm.*,
        w.address as warehouse_address,
        w.type as warehouse_type
      FROM warehouse_mappings wm
      LEFT JOIN warehouses w ON wm.warehouse_id = w.id
      WHERE wm.id = $1
    `, [id]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить маппинг по складу и маркетплейсу
   */
  async findByWarehouseAndMarketplace(warehouseId, marketplace) {
    const result = await query(`
      SELECT 
        wm.*,
        w.address as warehouse_address,
        w.type as warehouse_type
      FROM warehouse_mappings wm
      LEFT JOIN warehouses w ON wm.warehouse_id = w.id
      WHERE wm.warehouse_id = $1 AND wm.marketplace = $2
    `, [warehouseId, marketplace]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Получить маппинги по складу
   */
  async findByWarehouse(warehouseId) {
    const result = await query(`
      SELECT 
        wm.*,
        w.address as warehouse_address,
        w.type as warehouse_type
      FROM warehouse_mappings wm
      LEFT JOIN warehouses w ON wm.warehouse_id = w.id
      WHERE wm.warehouse_id = $1
      ORDER BY wm.marketplace
    `, [warehouseId]);
    
    return result.rows;
  }
  
  /**
   * Получить маппинги по маркетплейсу
   */
  async findByMarketplace(marketplace) {
    const result = await query(`
      SELECT 
        wm.*,
        w.address as warehouse_address,
        w.type as warehouse_type
      FROM warehouse_mappings wm
      LEFT JOIN warehouses w ON wm.warehouse_id = w.id
      WHERE wm.marketplace = $1
      ORDER BY wm.created_at DESC
    `, [marketplace]);
    
    return result.rows;
  }

  /**
   * Найти "свой" склад по идентификатору/названию склада маркетплейса.
   * marketplace_warehouse_id хранится как строка (для Ozon/WB/YM это может быть name или id).
   */
  async findOwnWarehouseIdByMarketplaceWarehouseId(marketplace, marketplaceWarehouseId) {
    const mp = String(marketplace || '').toLowerCase();
    const mw = String(marketplaceWarehouseId ?? '').trim();
    if (!mp || !mw) return null;
    const r = await query(
      `SELECT warehouse_id
       FROM warehouse_mappings
       WHERE marketplace = $1
         AND (
           TRIM(marketplace_warehouse_id) = TRIM($2)
           OR TRIM(REGEXP_REPLACE(marketplace_warehouse_id, '\\s*—.*$', '')) =
              TRIM(REGEXP_REPLACE($2, '\\s*—.*$', ''))
         )
       ORDER BY id DESC
       LIMIT 1`,
      [mp, mw]
    );
    return r.rows?.[0]?.warehouse_id ?? null;
  }
  
  /**
   * Создать маппинг
   */
  async create(mappingData) {
    const result = await query(`
      INSERT INTO warehouse_mappings (warehouse_id, marketplace, marketplace_warehouse_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [
      mappingData.warehouse_id,
      mappingData.marketplace,
      mappingData.marketplace_warehouse_id
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
    
    const allowedFields = ['warehouse_id', 'marketplace', 'marketplace_warehouse_id'];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        updateFields.push(`${field} = $${paramIndex++}`);
        params.push(updates[field]);
      }
    }
    
    if (updateFields.length === 0) {
      return await this.findById(id);
    }
    
    params.push(id);
    const result = await query(`
      UPDATE warehouse_mappings 
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
    const result = await query('DELETE FROM warehouse_mappings WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  
  /**
   * Удалить маппинг по складу и маркетплейсу
   */
  async deleteByWarehouseAndMarketplace(warehouseId, marketplace) {
    const result = await query(
      'DELETE FROM warehouse_mappings WHERE warehouse_id = $1 AND marketplace = $2 RETURNING id',
      [warehouseId, marketplace]
    );
    return result.rows.length > 0;
  }
}

export default new WarehouseMappingsRepositoryPG();

