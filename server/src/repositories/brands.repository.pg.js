/**
 * Brands Repository (PostgreSQL)
 * Репозиторий для работы с брендами в PostgreSQL
 */

import { query } from '../config/database.js';

class BrandsRepositoryPG {
  /**
   * Получить все бренды. При заданном profileId — только бренды этого аккаунта.
   */
  async findAll(options = {}) {
    const profileId = options.profileId ?? options.profile_id;
    if (profileId != null && profileId !== '') {
      const result = await query(
        `SELECT b.*
         FROM brands b
         WHERE b.profile_id = $1::bigint
         ORDER BY b.name`,
        [profileId]
      );
      return result.rows;
    }
    const result = await query('SELECT * FROM brands ORDER BY name');
    return result.rows;
  }
  
  /**
   * Получить бренд по ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM brands WHERE id = $1', [id]);
    return result.rows[0] || null;
  }
  
  /**
   * Получить бренд по имени
   */
  async findByName(name, profileId = null) {
    const n = String(name || '').trim();
    if (profileId != null && profileId !== '') {
      const result = await query('SELECT * FROM brands WHERE profile_id = $1::bigint AND LOWER(TRIM(name)) = LOWER(TRIM($2))', [profileId, n]);
      return result.rows[0] || null;
    }
    const result = await query('SELECT * FROM brands WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))', [n]);
    return result.rows[0] || null;
  }
  
  /**
   * Создать бренд
   */
  async create(data, options = {}) {
    // backward compatible: allow create('Brand name')
    const payload = (data != null && typeof data === 'object')
      ? data
      : { name: String(data || '').trim() };

    const name = String(payload.name || '').trim();
    if (!name) return null;
    const profileId = options.profileId ?? options.profile_id ?? payload.profileId ?? payload.profile_id ?? null;

    const description = payload.description != null && String(payload.description).trim() !== '' ? String(payload.description).trim() : null;
    const website = payload.website != null && String(payload.website).trim() !== '' ? String(payload.website).trim() : null;
    const certificateNumber = payload.certificate_number ?? payload.certificateNumber ?? null;
    const certificateValidFrom = payload.certificate_valid_from ?? payload.certificateValidFrom ?? null;
    const certificateValidTo = payload.certificate_valid_to ?? payload.certificateValidTo ?? null;

    const result = await query(
      `INSERT INTO brands (profile_id, name, description, website, certificate_number, certificate_valid_from, certificate_valid_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (profile_id, LOWER(TRIM(name))) DO UPDATE SET
         description = COALESCE(EXCLUDED.description, brands.description),
         website = COALESCE(EXCLUDED.website, brands.website),
         certificate_number = COALESCE(EXCLUDED.certificate_number, brands.certificate_number),
         certificate_valid_from = COALESCE(EXCLUDED.certificate_valid_from, brands.certificate_valid_from),
         certificate_valid_to = COALESCE(EXCLUDED.certificate_valid_to, brands.certificate_valid_to),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [profileId, name, description, website, certificateNumber, certificateValidFrom, certificateValidTo]
    );

    return result.rows[0] || await this.findByName(name, profileId);
  }
  
  /**
   * Обновить бренд
   */
  async update(id, updates) {
    // backward compatible: allow update(id, 'Brand name')
    const payload = (updates != null && typeof updates === 'object')
      ? updates
      : { name: String(updates || '').trim() };

    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    const map = {
      name: 'name',
      description: 'description',
      website: 'website',
      certificateNumber: 'certificate_number',
      certificate_number: 'certificate_number',
      certificateValidFrom: 'certificate_valid_from',
      certificate_valid_from: 'certificate_valid_from',
      certificateValidTo: 'certificate_valid_to',
      certificate_valid_to: 'certificate_valid_to',
    };

    for (const [k, col] of Object.entries(map)) {
      if (payload.hasOwnProperty(k)) {
        updateFields.push(`${col} = $${paramIndex++}`);
        params.push(payload[k] === '' ? null : payload[k]);
      }
    }

    if (updateFields.length === 0) return await this.findById(id);

    params.push(id);
    const result = await query(
      `UPDATE brands SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    return result.rows[0] || null;
  }
  
  /**
   * Удалить бренд
   */
  async delete(id) {
    const result = await query('DELETE FROM brands WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new BrandsRepositoryPG();

