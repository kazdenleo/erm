/**
 * Categories Repository (PostgreSQL)
 * Репозиторий для работы с категориями в PostgreSQL
 */

import { query } from '../config/database.js';

class CategoriesRepositoryPG {
  /**
   * Получить все категории
   */
  async findAll(options = {}) {
    const { marketplace } = options;
    
    let sql = 'SELECT * FROM categories WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (marketplace) {
      sql += ` AND marketplace = $${paramIndex++}`;
      params.push(marketplace);
    }
    
    sql += ' ORDER BY marketplace, name';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Получить категорию по ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM categories WHERE id = $1', [id]);
    return result.rows[0] || null;
  }
  
  /**
   * Получить категории по маркетплейсу
   */
  async findByMarketplace(marketplace) {
    const result = await query(`
      SELECT * FROM categories
      WHERE marketplace = $1
      ORDER BY name
    `, [marketplace]);
    
    return result.rows;
  }
  
  /**
   * Создать категорию
   */
  async create(categoryData) {
    const result = await query(`
      INSERT INTO categories (name, marketplace, marketplace_category_id, parent_id, path)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      categoryData.name,
      categoryData.marketplace,
      categoryData.marketplace_category_id || categoryData.external_id || null,
      categoryData.parent_id || null,
      categoryData.path || categoryData.name
    ]);
    
    return result.rows[0];
  }
  
  /**
   * Обновить категорию
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = ['name', 'marketplace', 'marketplace_category_id', 'parent_id', 'path'];
    
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
      UPDATE categories 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить категорию
   */
  async delete(id) {
    const result = await query('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new CategoriesRepositoryPG();

