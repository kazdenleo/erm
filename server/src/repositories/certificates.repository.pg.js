/**
 * Certificates Repository (PostgreSQL)
 * Сертификаты соответствия
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

  async _attachCategories(rows = []) {
    if (!rows.length) return rows;
    const certIds = rows.map((r) => r.id);
    const q = await query(
      `SELECT cuc.certificate_id, uc.id AS user_category_id, uc.name AS user_category_name
       FROM certificate_user_categories cuc
       JOIN user_categories uc ON uc.id = cuc.user_category_id
       WHERE cuc.certificate_id = ANY($1::bigint[])
       ORDER BY uc.name`,
      [certIds]
    );
    const byCert = new Map();
    for (const r of q.rows || []) {
      const list = byCert.get(r.certificate_id) || [];
      list.push({ id: r.user_category_id, name: r.user_category_name });
      byCert.set(r.certificate_id, list);
    }
    return rows.map((row) => {
      const cats = byCert.get(row.id) || [];
      return {
        ...row,
        user_category_ids: cats.map((c) => c.id),
        user_categories: cats,
        user_category_name: cats.length ? cats.map((c) => c.name).join(', ') : null
      };
    });
  }

  async findAll(options = {}) {
    const { brandId, userCategoryId, includeExpired = true } = options;
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
    if (!includeExpired) {
      sql += ` AND (c.valid_to IS NULL OR c.valid_to >= CURRENT_DATE)`;
    }

    sql += ` ORDER BY c.valid_to NULLS LAST, c.certificate_number`;
    const r = await query(sql, params);
    return await this._attachCategories(r.rows || []);
  }

  async findById(id) {
    const r = await query(
      `SELECT c.*, b.name AS brand_name
       FROM certificates c
       LEFT JOIN brands b ON b.id = c.brand_id
       WHERE c.id = $1`,
      [id]
    );
    if (!r.rows[0]) return null;
    const rows = await this._attachCategories([r.rows[0]]);
    return rows[0] || null;
  }

  async create(data) {
    const categoryIds = this._ensureArrayOfIds(
      data.user_category_ids ??
      data.userCategoryIds ??
      (data.user_category_id != null ? [data.user_category_id] : [])
    );
    const created = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO certificates (certificate_number, brand_id, user_category_id, photo_url, valid_from, valid_to, document_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          data.certificate_number,
          data.brand_id || null,
          categoryIds[0] || data.user_category_id || null, // legacy column (compat)
          data.photo_url || null,
          data.valid_from || null,
          data.valid_to || null,
          this._normalizeDocumentType(data.document_type ?? data.documentType),
        ]
      );
      const cert = r.rows[0] || null;
      if (cert && categoryIds.length) {
        for (const cid of categoryIds) {
          await client.query(
            `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [cert.id, cid]
          );
        }
      }
      return cert;
    });
    if (!created) return null;
    return await this.findById(created.id);
  }

  async update(id, updates) {
    const allowed = ['certificate_number', 'brand_id', 'user_category_id', 'photo_url', 'valid_from', 'valid_to', 'document_type'];
    const fields = [];
    const params = [];
    let i = 1;
    for (const f of allowed) {
      if (updates.hasOwnProperty(f)) {
        fields.push(`${f} = $${i++}`);
        if (f === 'document_type') {
          params.push(this._normalizeDocumentType(updates[f]));
        } else {
          params.push(updates[f] === '' ? null : updates[f]);
        }
      }
    }
    const hasCategories = updates.hasOwnProperty('user_category_ids') || updates.hasOwnProperty('userCategoryIds');
    if (fields.length === 0 && !hasCategories) return await this.findById(id);

    await transaction(async (client) => {
      if (fields.length > 0) {
        const p = [...params, id];
        await client.query(
          `UPDATE certificates SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i}`,
          p
        );
      }
      if (hasCategories) {
        const categoryIds = this._ensureArrayOfIds(updates.user_category_ids ?? updates.userCategoryIds ?? []);
        await client.query('DELETE FROM certificate_user_categories WHERE certificate_id = $1', [id]);
        for (const cid of categoryIds) {
          await client.query(
            `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, cid]
          );
        }
        // поддержка legacy single field
        await client.query(
          `UPDATE certificates SET user_category_id = $1 WHERE id = $2`,
          [categoryIds[0] || null, id]
        );
      }
    });
    return await this.findById(id);
  }

  async delete(id) {
    const r = await query('DELETE FROM certificates WHERE id = $1 RETURNING id', [id]);
    return r.rows.length > 0;
  }
}

export default new CertificatesRepositoryPG();

