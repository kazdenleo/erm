/**
 * Certificates Repository (PostgreSQL)
 * Сертификаты соответствия — привязка к бренду и конкретным товарам.
 */

import { query, transaction } from '../config/database.js';

class CertificatesRepositoryPG {
  _normalizeDocumentType(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'certificate' || v === 'declaration' || v === 'registration') return v;
    return 'certificate';
  }

  _ensureArrayOfIds(ids) {
    const arr = Array.isArray(ids) ? ids : [];
    return arr
      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  _profileId(options = {}) {
    const v = options.profileId ?? options.profile_id;
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async _attachRelations(rows = []) {
    if (!rows.length) return rows;
    const certIds = rows.map((r) => r.id);

    const [catsQ, prodsQ] = await Promise.all([
      query(
        `SELECT cuc.certificate_id, uc.id AS user_category_id, uc.name AS user_category_name
         FROM certificate_user_categories cuc
         JOIN user_categories uc ON uc.id = cuc.user_category_id
         WHERE cuc.certificate_id = ANY($1::bigint[])
         ORDER BY uc.name`,
        [certIds]
      ),
      query(
        `SELECT cp.certificate_id, p.id AS product_id, p.sku, p.name AS product_name
         FROM certificate_products cp
         JOIN products p ON p.id = cp.product_id
         WHERE cp.certificate_id = ANY($1::bigint[])
         ORDER BY p.sku NULLS LAST, p.name`,
        [certIds]
      ),
    ]);

    const catsByCert = new Map();
    for (const r of catsQ.rows || []) {
      const list = catsByCert.get(r.certificate_id) || [];
      list.push({ id: r.user_category_id, name: r.user_category_name });
      catsByCert.set(r.certificate_id, list);
    }

    const productsByCert = new Map();
    for (const r of prodsQ.rows || []) {
      const list = productsByCert.get(r.certificate_id) || [];
      list.push({
        id: r.product_id,
        sku: r.sku,
        name: r.product_name,
      });
      productsByCert.set(r.certificate_id, list);
    }

    return rows.map((row) => {
      const cats = catsByCert.get(row.id) || [];
      const products = productsByCert.get(row.id) || [];
      return {
        ...row,
        user_category_ids: cats.map((c) => c.id),
        user_categories: cats,
        user_category_name: cats.length ? cats.map((c) => c.name).join(', ') : null,
        product_ids: products.map((p) => p.id),
        products,
      };
    });
  }

  async findAll(options = {}) {
    const { brandId, userCategoryId, productId, includeExpired = true } = options;
    const profileId = this._profileId(options);
    let sql = `
      SELECT
        c.*,
        b.name AS brand_name
      FROM certificates c
      LEFT JOIN brands b ON b.id = c.brand_id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    if (profileId != null) {
      sql += ` AND c.profile_id = $${i++}::bigint`;
      params.push(profileId);
    }
    if (brandId != null && brandId !== '') {
      sql += ` AND c.brand_id = $${i++}`;
      params.push(brandId);
    }
    if (userCategoryId != null && userCategoryId !== '') {
      sql += ` AND EXISTS (
        SELECT 1
        FROM certificate_user_categories cuc
        WHERE cuc.certificate_id = c.id AND cuc.user_category_id = $${i++}
      )`;
      params.push(userCategoryId);
    }
    if (productId != null && productId !== '') {
      sql += ` AND EXISTS (
        SELECT 1
        FROM certificate_products cp
        WHERE cp.certificate_id = c.id AND cp.product_id = $${i++}::bigint
      )`;
      params.push(productId);
    }
    if (!includeExpired) {
      sql += ` AND (c.valid_to IS NULL OR c.valid_to >= CURRENT_DATE)`;
    }

    sql += ` ORDER BY c.valid_to NULLS LAST, c.certificate_number`;
    const r = await query(sql, params);
    return await this._attachRelations(r.rows || []);
  }

  async findById(id, options = {}) {
    const profileId = this._profileId(options);
    const params = [id];
    let sql = `SELECT c.*, b.name AS brand_name
       FROM certificates c
       LEFT JOIN brands b ON b.id = c.brand_id
       WHERE c.id = $1`;
    if (profileId != null) {
      sql += ` AND c.profile_id = $2::bigint`;
      params.push(profileId);
    }
    const r = await query(sql, params);
    if (!r.rows[0]) return null;
    const rows = await this._attachRelations([r.rows[0]]);
    return rows[0] || null;
  }

  async create(data) {
    const productIds = this._ensureArrayOfIds(
      data.product_ids ?? data.productIds ?? []
    );
    const categoryIds = this._ensureArrayOfIds(
      data.user_category_ids ??
        data.userCategoryIds ??
        (data.user_category_id != null ? [data.user_category_id] : [])
    );
    const profileId = this._profileId(data);
    const created = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO certificates (certificate_number, brand_id, user_category_id, photo_url, valid_from, valid_to, document_type, profile_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.certificate_number,
          data.brand_id || null,
          categoryIds[0] || data.user_category_id || null,
          data.photo_url || null,
          data.valid_from || null,
          data.valid_to || null,
          this._normalizeDocumentType(data.document_type ?? data.documentType),
          profileId,
        ]
      );
      const cert = r.rows[0] || null;
      if (!cert) return null;

      for (const pid of productIds) {
        await client.query(
          `INSERT INTO certificate_products (certificate_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cert.id, pid]
        );
      }
      for (const cid of categoryIds) {
        await client.query(
          `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cert.id, cid]
        );
      }
      return cert;
    });
    if (!created) return null;
    return await this.findById(created.id, { profileId });
  }

  async update(id, updates, options = {}) {
    const profileId = this._profileId(options);
    const allowed = [
      'certificate_number',
      'brand_id',
      'user_category_id',
      'photo_url',
      'valid_from',
      'valid_to',
      'document_type',
    ];
    const fields = [];
    const params = [];
    let i = 1;
    for (const f of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, f)) {
        fields.push(`${f} = $${i++}`);
        if (f === 'document_type') {
          params.push(this._normalizeDocumentType(updates[f]));
        } else {
          params.push(updates[f] === '' ? null : updates[f]);
        }
      }
    }
    const hasCategories =
      Object.prototype.hasOwnProperty.call(updates, 'user_category_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'userCategoryIds');
    const hasProducts =
      Object.prototype.hasOwnProperty.call(updates, 'product_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'productIds');
    if (fields.length === 0 && !hasCategories && !hasProducts) {
      return await this.findById(id, { profileId });
    }

    await transaction(async (client) => {
      if (fields.length > 0) {
        const p = [...params, id];
        let sql = `UPDATE certificates SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i}`;
        if (profileId != null) {
          sql += ` AND profile_id = $${i + 1}::bigint`;
          p.push(profileId);
        }
        const upd = await client.query(sql, p);
        if (profileId != null && upd.rowCount === 0) {
          const err = new Error('Сертификат не найден');
          err.statusCode = 404;
          throw err;
        }
      } else if (profileId != null) {
        const own = await client.query(
          'SELECT id FROM certificates WHERE id = $1 AND profile_id = $2::bigint',
          [id, profileId]
        );
        if (!own.rows[0]) {
          const err = new Error('Сертификат не найден');
          err.statusCode = 404;
          throw err;
        }
      }

      if (hasProducts) {
        const productIds = this._ensureArrayOfIds(updates.product_ids ?? updates.productIds ?? []);
        await client.query('DELETE FROM certificate_products WHERE certificate_id = $1', [id]);
        for (const pid of productIds) {
          await client.query(
            `INSERT INTO certificate_products (certificate_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, pid]
          );
        }
      }

      if (hasCategories) {
        const categoryIds = this._ensureArrayOfIds(
          updates.user_category_ids ?? updates.userCategoryIds ?? []
        );
        await client.query('DELETE FROM certificate_user_categories WHERE certificate_id = $1', [id]);
        for (const cid of categoryIds) {
          await client.query(
            `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, cid]
          );
        }
        await client.query(`UPDATE certificates SET user_category_id = $1 WHERE id = $2`, [
          categoryIds[0] || null,
          id,
        ]);
      }
    });
    return await this.findById(id, { profileId });
  }

  async delete(id, options = {}) {
    const profileId = this._profileId(options);
    if (profileId != null) {
      const r = await query(
        'DELETE FROM certificates WHERE id = $1 AND profile_id = $2::bigint RETURNING id',
        [id, profileId]
      );
      return r.rows.length > 0;
    }
    const r = await query('DELETE FROM certificates WHERE id = $1 RETURNING id', [id]);
    return r.rows.length > 0;
  }

  /**
   * Товары профиля без привязки ни к одному сертификату.
   */
  async findProductsWithoutCertificate(options = {}) {
    const profileId = this._profileId(options);
    const brandId = options.brandId ?? options.brand_id ?? null;
    const search = String(options.search || '').trim();
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);

    const params = [];
    let i = 1;
    let sql = `
      SELECT
        p.id,
        p.sku,
        p.name,
        p.brand_id,
        b.name AS brand_name,
        p.user_category_id,
        uc.name AS category_name
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN user_categories uc ON uc.id = p.user_category_id
      WHERE NOT EXISTS (
        SELECT 1 FROM certificate_products cp WHERE cp.product_id = p.id
      )
    `;
    if (profileId != null) {
      sql += ` AND p.profile_id = $${i++}::bigint`;
      params.push(profileId);
    }
    if (brandId != null && brandId !== '') {
      sql += ` AND p.brand_id = $${i++}::bigint`;
      params.push(brandId);
    }
    if (search) {
      sql += ` AND (
        p.sku ILIKE $${i}
        OR p.name ILIKE $${i}
        OR COALESCE(b.name, '') ILIKE $${i}
      )`;
      params.push(`%${search}%`);
      i += 1;
    }
    sql += ` ORDER BY p.sku NULLS LAST, p.name ASC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const countParams = params.slice(0, params.length - 2);
    let countSql = `
      SELECT COUNT(*)::int AS total
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE NOT EXISTS (
        SELECT 1 FROM certificate_products cp WHERE cp.product_id = p.id
      )
    `;
    let ci = 1;
    if (profileId != null) {
      countSql += ` AND p.profile_id = $${ci++}::bigint`;
    }
    if (brandId != null && brandId !== '') {
      countSql += ` AND p.brand_id = $${ci++}::bigint`;
    }
    if (search) {
      countSql += ` AND (
        p.sku ILIKE $${ci}
        OR p.name ILIKE $${ci}
        OR COALESCE(b.name, '') ILIKE $${ci}
      )`;
    }

    const [rows, count] = await Promise.all([
      query(sql, params),
      query(countSql, countParams),
    ]);
    return {
      items: rows.rows || [],
      total: Number(count.rows?.[0]?.total || 0),
      limit,
      offset,
    };
  }
}

export default new CertificatesRepositoryPG();
