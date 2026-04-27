/**
 * Profiles Repository (PostgreSQL)
 */

import { query } from '../config/database.js';

class ProfilesRepositoryPG {
  async findAll() {
    const result = await query(
      'SELECT * FROM profiles ORDER BY name'
    );
    return result.rows;
  }

  /**
   * Список профилей с количеством пользователей и организаций (админка продукта)
   */
  async findAllWithStats() {
    const result = await query(`
      SELECT
        p.*,
        (SELECT COUNT(*)::int FROM users u WHERE u.profile_id = p.id AND u.role <> 'admin') AS users_count,
        (
          SELECT COUNT(*)::int
          FROM organizations o
          WHERE o.profile_id = p.id
            OR (
              o.profile_id IS NULL
              AND (SELECT COUNT(*)::int FROM profiles) = 1
              AND p.id = (SELECT id FROM profiles ORDER BY id LIMIT 1)
            )
        ) AS organizations_count
      FROM profiles p
      ORDER BY p.name
    `);
    return result.rows;
  }

  async findById(id) {
    const result = await query(
      'SELECT * FROM profiles WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async create(data) {
    const d = typeof data === 'object' ? data : { name: data };
    const name = d.name ?? d;
    const result = await query(
      `INSERT INTO profiles (name, contact_full_name, contact_email, contact_phone, tariff)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        name,
        d.contact_full_name ?? d.contactFullName ?? null,
        d.contact_email ?? d.contactEmail ?? null,
        d.contact_phone ?? d.contactPhone ?? null,
        d.tariff ?? null,
      ]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const updates = typeof data === 'object' ? data : { name: data };
    const fields = [];
    const params = [];
    let i = 1;

    const set = (col, val) => {
      fields.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (updates.name !== undefined) set('name', updates.name);
    if (updates.contact_full_name !== undefined || updates.contactFullName !== undefined) {
      const v = updates.contact_full_name ?? updates.contactFullName;
      set('contact_full_name', v === '' ? null : v);
    }
    if (updates.contact_email !== undefined || updates.contactEmail !== undefined) {
      const v = updates.contact_email ?? updates.contactEmail;
      set('contact_email', v === '' ? null : v);
    }
    if (updates.contact_phone !== undefined || updates.contactPhone !== undefined) {
      const v = updates.contact_phone ?? updates.contactPhone;
      set('contact_phone', v === '' ? null : v);
    }
    if (updates.tariff !== undefined) {
      set('tariff', updates.tariff === '' ? null : updates.tariff);
    }
    if (updates.allow_private_orders !== undefined || updates.allowPrivateOrders !== undefined) {
      const v = updates.allow_private_orders ?? updates.allowPrivateOrders;
      set('allow_private_orders', v === true || v === '1' || v === 'true');
    }
    if (
      updates.require_reserved_stock_for_assembly !== undefined ||
      updates.requireReservedStockForAssembly !== undefined
    ) {
      const v = updates.require_reserved_stock_for_assembly ?? updates.requireReservedStockForAssembly;
      set('require_reserved_stock_for_assembly', v === true || v === '1' || v === 'true');
    }

    if (fields.length === 0) return await this.findById(id);
    params.push(id);
    const result = await query(
      `UPDATE profiles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async delete(id) {
    const result = await query('DELETE FROM profiles WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
}

export default new ProfilesRepositoryPG();
