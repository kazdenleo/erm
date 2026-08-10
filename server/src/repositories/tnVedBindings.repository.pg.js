/**
 * TN VED bindings repository (PostgreSQL)
 */

import { query, transaction } from '../config/database.js';

class TnVedBindingsRepositoryPG {
  _ensureArrayOfIds(ids) {
    const arr = Array.isArray(ids) ? ids : [];
    return arr
      .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  async _attachCategories(rows = []) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const q = await query(
      `SELECT tbc.binding_id, uc.id AS user_category_id, uc.name AS user_category_name
       FROM tn_ved_binding_categories tbc
       JOIN user_categories uc ON uc.id = tbc.user_category_id
       WHERE tbc.binding_id = ANY($1::bigint[])
       ORDER BY uc.name`,
      [ids]
    );
    const byId = new Map();
    for (const r of q.rows || []) {
      const list = byId.get(r.binding_id) || [];
      list.push({ id: r.user_category_id, name: r.user_category_name });
      byId.set(r.binding_id, list);
    }
    return rows.map((row) => {
      const cats = byId.get(row.id) || [];
      return {
        ...row,
        user_category_ids: cats.map((c) => c.id),
        user_categories: cats,
      };
    });
  }

  async findAll(options = {}) {
    const { brandId, userCategoryId } = options;
    let sql = `
      SELECT b.*, br.name AS brand_name
      FROM tn_ved_bindings b
      LEFT JOIN brands br ON br.id = b.brand_id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;
    if (brandId != null && brandId !== '') {
      sql += ` AND b.brand_id = $${i++}`;
      params.push(brandId);
    }
    if (userCategoryId != null && userCategoryId !== '') {
      sql += ` AND EXISTS (
        SELECT 1 FROM tn_ved_binding_categories tbc
        WHERE tbc.binding_id = b.id AND tbc.user_category_id = $${i++}
      )`;
      params.push(userCategoryId);
    }
    sql += ` ORDER BY br.name NULLS LAST, b.tn_ved_code`;
    const r = await query(sql, params);
    return await this._attachCategories(r.rows || []);
  }

  async findById(id) {
    const r = await query(
      `SELECT b.*, br.name AS brand_name
       FROM tn_ved_bindings b
       LEFT JOIN brands br ON br.id = b.brand_id
       WHERE b.id = $1`,
      [id]
    );
    if (!r.rows[0]) return null;
    const rows = await this._attachCategories([r.rows[0]]);
    return rows[0] || null;
  }

  async create(data) {
    const categoryIds = this._ensureArrayOfIds(
      data.user_category_ids ?? data.userCategoryIds ?? []
    );
    const created = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO tn_ved_bindings (brand_id, tn_ved_code)
         VALUES ($1, $2)
         RETURNING *`,
        [data.brand_id, data.tn_ved_code]
      );
      const row = r.rows[0] || null;
      if (row && categoryIds.length) {
        for (const cid of categoryIds) {
          await client.query(
            `INSERT INTO tn_ved_binding_categories (binding_id, user_category_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [row.id, cid]
          );
        }
      }
      return row;
    });
    if (!created) return null;
    return await this.findById(created.id);
  }

  async update(id, updates) {
    const fields = [];
    const params = [];
    let i = 1;
    if (updates.hasOwnProperty('brand_id')) {
      fields.push(`brand_id = $${i++}`);
      params.push(updates.brand_id);
    }
    if (updates.hasOwnProperty('tn_ved_code')) {
      fields.push(`tn_ved_code = $${i++}`);
      params.push(updates.tn_ved_code);
    }
    const hasCategories =
      updates.hasOwnProperty('user_category_ids') || updates.hasOwnProperty('userCategoryIds');
    if (fields.length === 0 && !hasCategories) return await this.findById(id);

    await transaction(async (client) => {
      if (fields.length > 0) {
        await client.query(
          `UPDATE tn_ved_bindings SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i}`,
          [...params, id]
        );
      }
      if (hasCategories) {
        const categoryIds = this._ensureArrayOfIds(
          updates.user_category_ids ?? updates.userCategoryIds ?? []
        );
        await client.query('DELETE FROM tn_ved_binding_categories WHERE binding_id = $1', [id]);
        for (const cid of categoryIds) {
          await client.query(
            `INSERT INTO tn_ved_binding_categories (binding_id, user_category_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, cid]
          );
        }
      }
    });
    return await this.findById(id);
  }

  async delete(id) {
    const r = await query('DELETE FROM tn_ved_bindings WHERE id = $1 RETURNING id', [id]);
    return r.rows.length > 0;
  }
}

export default new TnVedBindingsRepositoryPG();
