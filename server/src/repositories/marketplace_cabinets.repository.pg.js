/**
 * Marketplace Cabinets Repository (PostgreSQL)
 * Кабинеты маркетплейсов по организациям
 */

import { query } from '../config/database.js';

export async function findAll(organizationId, options = {}) {
  const { marketplaceType } = options;
  let sql = 'SELECT * FROM marketplace_cabinets WHERE organization_id = $1';
  const params = [organizationId];
  if (marketplaceType) {
    sql += ' AND marketplace_type = $2';
    params.push(marketplaceType);
  }
  sql += ' ORDER BY marketplace_type, sort_order, id';
  const result = await query(sql, params);
  return result.rows;
}

export async function findById(id) {
  const result = await query('SELECT * FROM marketplace_cabinets WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function countByOrganizationAndType(organizationId, marketplaceType) {
  const result = await query(
    'SELECT COUNT(*)::int AS cnt FROM marketplace_cabinets WHERE organization_id = $1 AND marketplace_type = $2',
    [organizationId, marketplaceType]
  );
  return result.rows[0]?.cnt ?? 0;
}

export async function create(data) {
  const result = await query(`
    INSERT INTO marketplace_cabinets (organization_id, marketplace_type, name, config, is_active, sort_order)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    RETURNING *
  `, [
    data.organization_id,
    data.marketplace_type,
    data.name || data.marketplace_type,
    JSON.stringify(data.config || {}),
    data.is_active !== undefined ? data.is_active : true,
    data.sort_order ?? 0
  ]);
  return result.rows[0];
}

export async function update(id, data) {
  const updates = [];
  const params = [];
  let idx = 1;
  if (data.name !== undefined) { updates.push(`name = $${idx++}`); params.push(data.name); }
  if (data.config !== undefined) { updates.push(`config = $${idx++}::jsonb`); params.push(JSON.stringify(data.config)); }
  if (data.is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(data.is_active); }
  if (data.sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); params.push(data.sort_order); }
  if (updates.length === 0) return await findById(id);
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  const result = await query(
    `UPDATE marketplace_cabinets SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

export async function deleteById(id) {
  const result = await query('DELETE FROM marketplace_cabinets WHERE id = $1 RETURNING id', [id]);
  return result.rows.length > 0;
}
