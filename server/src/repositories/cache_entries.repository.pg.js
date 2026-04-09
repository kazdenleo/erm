/**
 * Cache Entries Repository (PostgreSQL)
 * Репозиторий для работы с кэшем в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class CacheEntriesRepositoryPG {
  /**
   * Получить все записи кэша
   */
  async findAll(options = {}) {
    const { cacheType, expired } = options;
    
    let sql = 'SELECT * FROM cache_entries WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (cacheType) {
      sql += ` AND cache_type = $${paramIndex++}`;
      params.push(cacheType);
    }
    
    if (expired === false) {
      sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;
    } else if (expired === true) {
      sql += ` AND expires_at IS NOT NULL AND expires_at <= NOW()`;
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Получить запись кэша по ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM cache_entries WHERE id = $1', [id]);
    return result.rows[0] || null;
  }
  
  /**
   * Получить запись кэша по типу и ключу
   */
  async findByTypeAndKey(cacheType, cacheKey) {
    const result = await query(
      'SELECT * FROM cache_entries WHERE cache_type = $1 AND cache_key = $2',
      [cacheType, cacheKey]
    );
    return result.rows[0] || null;
  }
  
  /**
   * Получить все записи кэша по типу
   */
  async findByType(cacheType, options = {}) {
    const { expired } = options;
    
    let sql = 'SELECT * FROM cache_entries WHERE cache_type = $1';
    const params = [cacheType];
    let paramIndex = 2;
    
    if (expired === false) {
      sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;
    } else if (expired === true) {
      sql += ` AND expires_at IS NOT NULL AND expires_at <= NOW()`;
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Создать или обновить запись кэша
   */
  async upsert(cacheData) {
    const result = await query(`
      INSERT INTO cache_entries (cache_type, cache_key, cache_value, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cache_type, cache_key)
      DO UPDATE SET
        cache_value = EXCLUDED.cache_value,
        expires_at = EXCLUDED.expires_at,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      cacheData.cache_type,
      cacheData.cache_key,
      typeof cacheData.cache_value === 'string' ? cacheData.cache_value : JSON.stringify(cacheData.cache_value),
      cacheData.expires_at || null
    ]);
    
    return result.rows[0];
  }
  
  /**
   * Обновить запись кэша
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = ['cache_type', 'cache_key', 'cache_value', 'expires_at'];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        if (field === 'cache_value') {
          updateFields.push(`${field} = $${paramIndex++}`);
          params.push(typeof updates[field] === 'string' ? updates[field] : JSON.stringify(updates[field]));
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
      UPDATE cache_entries 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить запись кэша
   */
  async delete(id) {
    const result = await query('DELETE FROM cache_entries WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  
  /**
   * Удалить запись кэша по типу и ключу
   */
  async deleteByTypeAndKey(cacheType, cacheKey) {
    const result = await query(
      'DELETE FROM cache_entries WHERE cache_type = $1 AND cache_key = $2 RETURNING id',
      [cacheType, cacheKey]
    );
    return result.rows.length > 0;
  }
  
  /**
   * Удалить все записи кэша по типу
   */
  async deleteByType(cacheType) {
    const result = await query(
      'DELETE FROM cache_entries WHERE cache_type = $1 RETURNING id',
      [cacheType]
    );
    return result.rows.length;
  }
  
  /**
   * Очистить устаревшие записи кэша
   */
  async clearExpired() {
    const result = await query(`
      DELETE FROM cache_entries
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING id
    `);
    return result.rows.length;
  }
  
  /**
   * Очистить все записи кэша
   */
  async clearAll() {
    const result = await query('DELETE FROM cache_entries RETURNING id');
    return result.rows.length;
  }
}

export default new CacheEntriesRepositoryPG();

