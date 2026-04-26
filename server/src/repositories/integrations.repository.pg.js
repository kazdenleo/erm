/**
 * Integrations Repository (PostgreSQL)
 * Репозиторий для работы с интеграциями в PostgreSQL
 */

import { query, transaction } from '../config/database.js';

class IntegrationsRepositoryPG {
  /**
   * Получить все интеграции
   */
  async findAll(options = {}) {
    const { type, isActive, profileId, organizationId } = options;
    
    let sql = 'SELECT * FROM integrations WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (profileId != null && profileId !== '') {
      sql += ` AND profile_id = $${paramIndex++}`;
      params.push(profileId);
    }

    if (organizationId != null && organizationId !== '') {
      sql += ` AND organization_id = $${paramIndex++}`;
      params.push(organizationId);
    }
    
    if (type) {
      sql += ` AND type = $${paramIndex++}`;
      params.push(type);
    }
    
    if (isActive !== undefined) {
      sql += ` AND is_active = $${paramIndex++}`;
      params.push(isActive);
    }
    
    // Стабильный порядок: при одинаковом name несколько строк (разные organization_id) не «прыгают».
    sql += ' ORDER BY type, name, id';
    
    const result = await query(sql, params);
    return result.rows;
  }
  
  /**
   * Получить интеграцию по ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM integrations WHERE id = $1', [id]);
    return result.rows[0] || null;
  }
  
  /**
   * Получить интеграцию по коду
   */
  async findByCode(code, profileId = null, organizationId = null) {
    // В multi-tenant режиме нельзя читать "глобальную" интеграцию без profile_id:
    // это приводит к смешиванию ключей между аккаунтами.
    if (profileId == null || profileId === '') return null;
    if (organizationId != null && organizationId !== '') {
      const result = await query(
        'SELECT * FROM integrations WHERE profile_id = $1 AND organization_id = $2 AND code = $3',
        [profileId, organizationId, code]
      );
      return result.rows[0] || null;
    }
    // Legacy: если organizationId не передали — не возвращаем интеграции, чтобы не смешивать организации.
    return null;
  }
  
  /**
   * Получить интеграции по типу
   */
  async findByType(type) {
    const result = await query(`
      SELECT * FROM integrations
      WHERE type = $1 AND is_active = true
      ORDER BY name
    `, [type]);
    
    return result.rows;
  }
  
  /**
   * Создать интеграцию
   */
  async create(integrationData) {
    const result = await query(`
      INSERT INTO integrations (profile_id, organization_id, type, name, code, config, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      integrationData.profile_id ?? integrationData.profileId ?? null,
      integrationData.organization_id ?? integrationData.organizationId ?? null,
      integrationData.type,
      integrationData.name,
      integrationData.code,
      JSON.stringify(integrationData.config || {}),
      integrationData.is_active !== undefined ? integrationData.is_active : true
    ]);
    
    return result.rows[0];
  }
  
  /**
   * Обновить интеграцию
   */
  async update(id, updates) {
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    const allowedFields = ['type', 'name', 'code', 'config', 'is_active', 'organization_id'];
    
    for (const field of allowedFields) {
      if (updates.hasOwnProperty(field)) {
        if (field === 'config') {
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
      UPDATE integrations 
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
      RETURNING *
    `, params);
    
    return result.rows[0] || null;
  }
  
  /**
   * Обновить конфигурацию интеграции
   */
  async updateConfig(id, config) {
    const result = await query(`
      UPDATE integrations 
      SET config = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [JSON.stringify(config), id]);
    
    return result.rows[0] || null;
  }
  
  /**
   * Удалить интеграцию
   */
  async delete(id) {
    const result = await query('DELETE FROM integrations WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new IntegrationsRepositoryPG();

