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
        `SELECT DISTINCT ON (LOWER(TRIM(b.name))) b.*
         FROM (
           SELECT b1.*
           FROM brands b1
           WHERE b1.profile_id = $1::bigint
           UNION
           SELECT b2.*
           FROM brands b2
           INNER JOIN products p ON p.brand_id = b2.id
           WHERE p.profile_id = $1::bigint
         ) b
         ORDER BY LOWER(TRIM(b.name)),
           CASE WHEN b.profile_id = $1::bigint THEN 0 ELSE 1 END,
           b.id`,
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
    const ozonBrandPromotionPercent = payload.ozon_brand_promotion_percent ?? payload.ozonBrandPromotionPercent ?? null;
    const ozonBrandPromotionEnabled =
      payload.ozon_brand_promotion_enabled === true ||
      payload.ozon_brand_promotion_enabled === '1' ||
      payload.ozonBrandPromotionEnabled === true ||
      payload.ozonBrandPromotionEnabled === '1';
    const manufacturerCountry =
      payload.manufacturer_country ?? payload.manufacturerCountry ?? null;

    const result = await query(
      `INSERT INTO brands (profile_id, name, description, website, certificate_number, certificate_valid_from, certificate_valid_to, ozon_brand_promotion_percent, ozon_brand_promotion_enabled, manufacturer_country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (profile_id, LOWER(TRIM(name))) DO UPDATE SET
         description = COALESCE(EXCLUDED.description, brands.description),
         website = COALESCE(EXCLUDED.website, brands.website),
         certificate_number = COALESCE(EXCLUDED.certificate_number, brands.certificate_number),
         certificate_valid_from = COALESCE(EXCLUDED.certificate_valid_from, brands.certificate_valid_from),
         certificate_valid_to = COALESCE(EXCLUDED.certificate_valid_to, brands.certificate_valid_to),
         ozon_brand_promotion_percent = COALESCE(EXCLUDED.ozon_brand_promotion_percent, brands.ozon_brand_promotion_percent),
         ozon_brand_promotion_enabled = COALESCE(EXCLUDED.ozon_brand_promotion_enabled, brands.ozon_brand_promotion_enabled),
         manufacturer_country = COALESCE(EXCLUDED.manufacturer_country, brands.manufacturer_country),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        profileId,
        name,
        description,
        website,
        certificateNumber,
        certificateValidFrom,
        certificateValidTo,
        ozonBrandPromotionPercent,
        ozonBrandPromotionEnabled,
        manufacturerCountry != null && String(manufacturerCountry).trim() !== ''
          ? String(manufacturerCountry).trim()
          : null,
      ]
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
      ozonBrandPromotionPercent: 'ozon_brand_promotion_percent',
      ozon_brand_promotion_percent: 'ozon_brand_promotion_percent',
      ozonBrandPromotionEnabled: 'ozon_brand_promotion_enabled',
      ozon_brand_promotion_enabled: 'ozon_brand_promotion_enabled',
      manufacturerCountry: 'manufacturer_country',
      manufacturer_country: 'manufacturer_country',
    };

    for (const [k, col] of Object.entries(map)) {
      if (payload.hasOwnProperty(k)) {
        if (col === 'ozon_brand_promotion_enabled') {
          updateFields.push(`${col} = $${paramIndex++}`);
          params.push(
            payload[k] === true || payload[k] === '1' || payload[k] === 'true'
          );
        } else {
          updateFields.push(`${col} = $${paramIndex++}`);
          params.push(payload[k] === '' ? null : payload[k]);
        }
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

  async findMarketplaceMappings(brandId) {
    const bid = Number(brandId);
    if (!Number.isFinite(bid) || bid < 1) return [];
    const r = await query(
      `SELECT id, brand_id, marketplace, mp_brand_name, mp_brand_id, mp_meta, created_at, updated_at
       FROM brand_marketplace_mappings
       WHERE brand_id = $1
       ORDER BY marketplace`,
      [bid]
    );
    return r.rows || [];
  }

  async upsertMarketplaceMapping(brandId, marketplace, data = {}) {
    const bid = Number(brandId);
    const mp = String(marketplace || '').trim().toLowerCase();
    if (!Number.isFinite(bid) || bid < 1 || !mp) return null;
    const name =
      data.mp_brand_name != null && String(data.mp_brand_name).trim() !== ''
        ? String(data.mp_brand_name).trim()
        : null;
    const mpId =
      data.mp_brand_id != null && String(data.mp_brand_id).trim() !== ''
        ? String(data.mp_brand_id).trim()
        : null;
    const meta = data.mp_meta != null ? JSON.stringify(data.mp_meta) : null;
    const r = await query(
      `INSERT INTO brand_marketplace_mappings (brand_id, marketplace, mp_brand_name, mp_brand_id, mp_meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (brand_id, marketplace) DO UPDATE SET
         mp_brand_name = EXCLUDED.mp_brand_name,
         mp_brand_id = EXCLUDED.mp_brand_id,
         mp_meta = COALESCE(EXCLUDED.mp_meta, brand_marketplace_mappings.mp_meta),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [bid, mp, name, mpId, meta]
    );
    return r.rows[0] || null;
  }

  async replaceMarketplaceMappings(brandId, items = []) {
    const bid = Number(brandId);
    if (!Number.isFinite(bid) || bid < 1) return [];
    await query('DELETE FROM brand_marketplace_mappings WHERE brand_id = $1', [bid]);
    const out = [];
    for (const item of items) {
      const row = await this.upsertMarketplaceMapping(bid, item.marketplace, item);
      if (row) out.push(row);
    }
    return out;
  }
}

export default new BrandsRepositoryPG();

