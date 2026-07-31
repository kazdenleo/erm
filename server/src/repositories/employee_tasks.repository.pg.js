/**
 * Employee Tasks Repository (PostgreSQL)
 */

import { query } from '../config/database.js';

const SELECT_BASE = `
  SELECT
    t.*,
    a.full_name AS assignee_full_name,
    a.email AS assignee_email,
    a.account_role AS assignee_account_role,
    c.full_name AS created_by_full_name,
    c.email AS created_by_email,
    p.sku AS product_sku,
    p.name AS product_name
  FROM employee_tasks t
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.created_by_id
  LEFT JOIN products p ON p.id = t.product_id
`;

class EmployeeTasksRepositoryPG {
  async findAll({ profileId, status, assigneeId } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (profileId != null && profileId !== '') {
      where.push(`t.profile_id = $${i++}::bigint`);
      params.push(profileId);
    }
    if (status) {
      where.push(`t.status = $${i++}`);
      params.push(status);
    }
    if (assigneeId != null && assigneeId !== '') {
      where.push(`t.assignee_id = $${i++}::bigint`);
      params.push(assigneeId);
    }
    const sql = `${SELECT_BASE}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
        t.created_at DESC`;
    const result = await query(sql, params);
    return result.rows;
  }

  async findById(id) {
    const result = await query(`${SELECT_BASE} WHERE t.id = $1`, [id]);
    return result.rows[0] || null;
  }

  /** Одна открытая задача данного типа на аккаунт (для сводных задач вроде проверки габаритов). */
  async findOpenByType({ profileId, taskType }) {
    const result = await query(
      `${SELECT_BASE}
       WHERE t.profile_id = $1::bigint
         AND t.task_type = $2
         AND t.status = 'open'
       ORDER BY t.id ASC
       LIMIT 1`,
      [profileId, taskType]
    );
    return result.rows[0] || null;
  }

  async create(data) {
    const result = await query(
      `INSERT INTO employee_tasks (
         profile_id, title, description, task_type, status,
         assignee_id, created_by_id, product_id, marketplace, meta
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::text)::jsonb)
       RETURNING *`,
      [
        data.profileId,
        data.title,
        data.description ?? null,
        data.taskType || 'text',
        data.status || 'open',
        data.assigneeId ?? null,
        data.createdById ?? null,
        data.productId ?? null,
        data.marketplace ?? null,
        JSON.stringify(data.meta && typeof data.meta === 'object' ? data.meta : {}),
      ]
    );
    return this.findById(result.rows[0].id);
  }

  async update(id, updates) {
    const fields = [];
    const params = [];
    let i = 1;
    const map = {
      title: 'title',
      description: 'description',
      status: 'status',
      assignee_id: 'assignee_id',
      assigneeId: 'assignee_id',
      completed_at: 'completed_at',
      completedAt: 'completed_at',
      completed_by_id: 'completed_by_id',
      completedById: 'completed_by_id',
      meta: 'meta',
    };
    for (const [key, col] of Object.entries(map)) {
      if (updates[key] === undefined) continue;
      if (col === 'meta') {
        fields.push(`meta = $${i++}::jsonb`);
        params.push(JSON.stringify(updates[key] && typeof updates[key] === 'object' ? updates[key] : {}));
      } else {
        fields.push(`${col} = $${i++}`);
        params.push(updates[key]);
      }
    }
    if (fields.length === 0) return this.findById(id);
    fields.push('updated_at = NOW()');
    params.push(id);
    await query(
      `UPDATE employee_tasks SET ${fields.join(', ')} WHERE id = $${i}`,
      params
    );
    return this.findById(id);
  }

  async findFirstWarehouseManager(profileId) {
    const result = await query(
      `SELECT id, email, full_name, account_role
       FROM users
       WHERE profile_id = $1::bigint
         AND role <> 'admin'
         AND LOWER(TRIM(COALESCE(account_role, ''))) = 'warehouse_manager'
       ORDER BY id ASC
       LIMIT 1`,
      [profileId]
    );
    return result.rows[0] || null;
  }
}

export default new EmployeeTasksRepositoryPG();
