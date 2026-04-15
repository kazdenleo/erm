/**
 * Warehouses Repository (PostgreSQL)
 * Репозиторий для работы со складами в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class WarehousesRepositoryPG {
  /**
   * Получить все склады
   */
  async findAll(options = {}) {
    const { type, supplierId, mainWarehouseId, organizationId, profileId } = options;
    const pid = normalizeProfileId(profileId);
    
    let sql = `
      SELECT 
        w.*,
        s.name as supplier_name,
        s.code as supplier_code,
        mw.address as main_warehouse_address
      FROM warehouses w
      LEFT JOIN suppliers s ON w.supplier_id = s.id
      LEFT JOIN warehouses mw ON w.main_warehouse_id = mw.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (type) {
      sql += ` AND w.type = $${paramIndex++}`;
      params.push(type);
    }
    
    if (supplierId) {
      sql += ` AND w.supplier_id = $${paramIndex++}`;
      params.push(supplierId);
    }
    
    if (mainWarehouseId) {
      sql += ` AND w.main_warehouse_id = $${paramIndex++}`;
      params.push(mainWarehouseId);
    }
    
    if (organizationId != null && organizationId !== '') {
      sql += ` AND w.organization_id = $${paramIndex++}`;
      params.push(organizationId);
    }

    if (pid) {
      sql += ` AND w.profile_id = $${paramIndex++}`;
      params.push(pid);
    }
    
    sql += ' ORDER BY w.type, w.address';
    
    const result = await query(sql, params);
    // Маппинг полей из snake_case в camelCase для фронтенда
    return result.rows.map(row => ({
      ...row,
      supplierId: row.supplier_id,
      mainWarehouseId: row.main_warehouse_id,
      organizationId: row.organization_id,
      supplierName: row.supplier_name,
      supplierCode: row.supplier_code,
      mainWarehouseAddress: row.main_warehouse_address,
      orderAcceptanceTime: row.order_acceptance_time,
      wbWarehouseName: row.wb_warehouse_name
    }));
  }
  
  /**
   * Получить склад по ID
   */
  async findById(id, profileId = null) {
    const pid = normalizeProfileId(profileId);
    const result = pid
      ? await query(`
      SELECT 
        w.*,
        s.name as supplier_name,
        s.code as supplier_code,
        mw.address as main_warehouse_address
      FROM warehouses w
      LEFT JOIN suppliers s ON w.supplier_id = s.id
      LEFT JOIN warehouses mw ON w.main_warehouse_id = mw.id
      WHERE w.id = $1 AND w.profile_id = $2
    `, [id, pid])
      : await query(`
      SELECT 
        w.*,
        s.name as supplier_name,
        s.code as supplier_code,
        mw.address as main_warehouse_address
      FROM warehouses w
      LEFT JOIN suppliers s ON w.supplier_id = s.id
      LEFT JOIN warehouses mw ON w.main_warehouse_id = mw.id
      WHERE w.id = $1
    `, [id]);
    
    if (!result.rows[0]) {
      return null;
    }
    
    const row = result.rows[0];
    // Маппинг полей из snake_case в camelCase для фронтенда
    return {
      ...row,
      supplierId: row.supplier_id,
      mainWarehouseId: row.main_warehouse_id,
      organizationId: row.organization_id,
      supplierName: row.supplier_name,
      supplierCode: row.supplier_code,
      mainWarehouseAddress: row.main_warehouse_address,
      orderAcceptanceTime: row.order_acceptance_time,
      wbWarehouseName: row.wb_warehouse_name
    };
  }
  
  /**
   * Получить главные склады (без main_warehouse_id)
   */
  async findMainWarehouses() {
    const result = await query(`
      SELECT * FROM warehouses
      WHERE main_warehouse_id IS NULL
      ORDER BY address
    `);
    
    return result.rows;
  }
  
  /**
   * Получить склады поставщика
   */
  async findBySupplierId(supplierId) {
    const result = await query(`
      SELECT * FROM warehouses
      WHERE supplier_id = $1
      ORDER BY address
    `, [supplierId]);
    
    return result.rows;
  }
  
  /**
   * Создать склад
   */
  async create(warehouseData) {
    const orgId = warehouseData.organization_id != null && warehouseData.organization_id !== '' ? warehouseData.organization_id : null;
    const profId = normalizeProfileId(warehouseData.profile_id ?? warehouseData.profileId);
    // Пытаемся вставить с полем wb_warehouse_name и organization_id
    try {
      const result = await query(`
        INSERT INTO warehouses (type, address, supplier_id, main_warehouse_id, order_acceptance_time, wb_warehouse_name, organization_id, profile_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        warehouseData.type || 'warehouse',
        warehouseData.address || null,
        warehouseData.supplier_id || null,
        warehouseData.main_warehouse_id || null,
        warehouseData.order_acceptance_time || null,
        warehouseData.wb_warehouse_name || null,
        orgId,
        profId
      ]);
      
      const row = result.rows[0];
      return {
        ...row,
        supplierId: row.supplier_id,
        mainWarehouseId: row.main_warehouse_id,
        organizationId: row.organization_id,
        orderAcceptanceTime: row.order_acceptance_time,
        wbWarehouseName: row.wb_warehouse_name || null
      };
    } catch (error) {
      if (error.message && error.message.includes('organization_id')) {
        try {
          const result = await query(`
            INSERT INTO warehouses (type, address, supplier_id, main_warehouse_id, order_acceptance_time, wb_warehouse_name, profile_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `, [
            warehouseData.type || 'warehouse',
            warehouseData.address || null,
            warehouseData.supplier_id || null,
            warehouseData.main_warehouse_id || null,
            warehouseData.order_acceptance_time || null,
            warehouseData.wb_warehouse_name || null,
            profId
          ]);
          const row = result.rows[0];
          return { ...row, supplierId: row.supplier_id, mainWarehouseId: row.main_warehouse_id, organizationId: null, orderAcceptanceTime: row.order_acceptance_time, wbWarehouseName: row.wb_warehouse_name || null };
        } catch (e) {
          if (e.message && e.message.includes('wb_warehouse_name')) {
            const result = await query(`
              INSERT INTO warehouses (type, address, supplier_id, main_warehouse_id, order_acceptance_time, profile_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING *
            `, [
              warehouseData.type || 'warehouse',
              warehouseData.address || null,
              warehouseData.supplier_id || null,
              warehouseData.main_warehouse_id || null,
              warehouseData.order_acceptance_time || null,
              profId
            ]);
            const row = result.rows[0];
            return { ...row, supplierId: row.supplier_id, mainWarehouseId: row.main_warehouse_id, organizationId: null, orderAcceptanceTime: row.order_acceptance_time, wbWarehouseName: null };
          }
          throw e;
        }
      }
      if (error.message && error.message.includes('wb_warehouse_name')) {
        const result = await query(`
          INSERT INTO warehouses (type, address, supplier_id, main_warehouse_id, order_acceptance_time, organization_id, profile_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `, [
          warehouseData.type || 'warehouse',
          warehouseData.address || null,
          warehouseData.supplier_id || null,
          warehouseData.main_warehouse_id || null,
          warehouseData.order_acceptance_time || null,
          orgId,
          profId
        ]);
        const row = result.rows[0];
        return { ...row, supplierId: row.supplier_id, mainWarehouseId: row.main_warehouse_id, organizationId: row.organization_id, orderAcceptanceTime: row.order_acceptance_time, wbWarehouseName: null };
      }
      throw error;
    }
  }
  
  /**
   * Обновить склад
   */
  async update(id, updates, profileId = null) {
    const pid = normalizeProfileId(profileId);
    const buildUpdateQuery = (includeWbWarehouseName = true) => {
      const updateFields = [];
      const params = [];
      let paramIndex = 1;
      
      const allowedFields = includeWbWarehouseName 
        ? ['type', 'address', 'supplier_id', 'main_warehouse_id', 'order_acceptance_time', 'wb_warehouse_name', 'organization_id']
        : ['type', 'address', 'supplier_id', 'main_warehouse_id', 'order_acceptance_time', 'organization_id'];
      
      for (const field of allowedFields) {
        if (updates.hasOwnProperty(field)) {
          let value = updates[field];
          
          // Для полей типа BIGINT (supplier_id, main_warehouse_id, organization_id) преобразуем пустые строки в null
          if ((field === 'supplier_id' || field === 'main_warehouse_id' || field === 'organization_id') && value === '') {
            value = null;
          }
          
          // Для wb_warehouse_name обрабатываем null значения - они должны обновляться
          if (field === 'wb_warehouse_name') {
            // Если значение явно передано (даже null), обновляем поле
            // null означает очистку поля
            updateFields.push(`${field} = $${paramIndex++}`);
            params.push(value);
            console.log(`[WarehousesRepository] Adding wb_warehouse_name to update:`, value);
          } else {
            updateFields.push(`${field} = $${paramIndex++}`);
            params.push(value);
          }
        }
      }
      
      return { updateFields, params, paramIndex };
    };
    
    let { updateFields, params, paramIndex } = buildUpdateQuery(true);
    
    console.log('[WarehousesRepository] Update fields:', updateFields);
    console.log('[WarehousesRepository] Updates object:', JSON.stringify(updates, null, 2));
    console.log('[WarehousesRepository] Has wb_warehouse_name:', updates.hasOwnProperty('wb_warehouse_name'));
    console.log('[WarehousesRepository] wb_warehouse_name value:', updates.wb_warehouse_name);
    console.log('[WarehousesRepository] wb_warehouse_name type:', typeof updates.wb_warehouse_name);
    
    if (updateFields.length === 0) {
      return await this.findById(id, profileId);
    }
    
    params.push(id);
    if (pid) params.push(pid);
    
    try {
      const sql = `
        UPDATE warehouses 
        SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex}${pid ? ` AND profile_id = $${paramIndex + 1}` : ''}
        RETURNING *
      `;
      console.log('[WarehousesRepository] SQL query:', sql);
      console.log('[WarehousesRepository] SQL params:', params);
      console.log('[WarehousesRepository] SQL params count:', params.length);
      console.log('[WarehousesRepository] SQL paramIndex:', paramIndex);
      
      const result = await query(sql, params);
      
      if (!result.rows[0]) {
        return null;
      }
      
      const row = result.rows[0];
      console.log('[WarehousesRepository] Updated row from DB:', JSON.stringify(row, null, 2));
      console.log('[WarehousesRepository] wb_warehouse_name from DB:', row.wb_warehouse_name);
      console.log('[WarehousesRepository] wb_warehouse_name from DB type:', typeof row.wb_warehouse_name);
      // Маппинг полей из snake_case в camelCase для фронтенда
      const mapped = {
        ...row,
        supplierId: row.supplier_id,
        mainWarehouseId: row.main_warehouse_id,
        organizationId: row.organization_id,
        orderAcceptanceTime: row.order_acceptance_time,
        wbWarehouseName: row.wb_warehouse_name || null
      };
      console.log('[WarehousesRepository] Mapped result:', mapped);
      console.log('[WarehousesRepository] Mapped wbWarehouseName:', mapped.wbWarehouseName);
      return mapped;
    } catch (error) {
      // Если ошибка связана с отсутствием колонки wb_warehouse_name, пробуем без неё
      if (error.message && error.message.includes('wb_warehouse_name')) {
        const retry = buildUpdateQuery(false);
        
        if (retry.updateFields.length === 0) {
          return await this.findById(id, profileId);
        }
        
        retry.params.push(id);
        if (pid) retry.params.push(pid);
        const result = await query(`
          UPDATE warehouses 
          SET ${retry.updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${retry.paramIndex}${pid ? ` AND profile_id = $${retry.paramIndex + 1}` : ''}
          RETURNING *
        `, retry.params);
        
        if (!result.rows[0]) {
          return null;
        }
        
        const row = result.rows[0];
        return {
          ...row,
          supplierId: row.supplier_id,
          mainWarehouseId: row.main_warehouse_id,
          organizationId: row.organization_id,
          orderAcceptanceTime: row.order_acceptance_time,
          wbWarehouseName: null
        };
      }
      throw error;
    }
  }
  
  /**
   * Удалить склад
   */
  async delete(id, profileId = null) {
    const pid = normalizeProfileId(profileId);
    const result = pid
      ? await query('DELETE FROM warehouses WHERE id = $1 AND profile_id = $2 RETURNING id', [id, pid])
      : await query('DELETE FROM warehouses WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new WarehousesRepositoryPG();

