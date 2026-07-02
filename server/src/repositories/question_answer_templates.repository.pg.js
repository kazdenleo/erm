/**
 * Шаблоны быстрых ответов на вопросы маркетплейсов
 */

import { query } from '../config/database.js';

function rowToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    title: row.title,
    body: row.body ?? '',
    sortOrder: row.sort_order != null ? Number(row.sort_order) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class QuestionAnswerTemplatesRepositoryPG {
  async listByProfile(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];
    const result = await query(
      `SELECT id, profile_id, title, body, sort_order, created_at, updated_at
       FROM question_answer_templates
       WHERE profile_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [pid]
    );
    return (result.rows || []).map(rowToApi);
  }

  async findByIdAndProfile(id, profileId) {
    const nid = Number(id);
    const pid = Number(profileId);
    if (!Number.isFinite(nid) || nid < 1 || !Number.isFinite(pid) || pid < 1) return null;
    const result = await query(
      `SELECT id, profile_id, title, body, sort_order, created_at, updated_at
       FROM question_answer_templates
       WHERE id = $1 AND profile_id = $2`,
      [nid, pid]
    );
    return rowToApi(result.rows[0] || null);
  }

  async create(profileId, { title, body, sortOrder = null }) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Некорректный profile_id');
      err.statusCode = 400;
      throw err;
    }
    const t = String(title ?? '').trim();
    if (!t) {
      const err = new Error('Укажите название шаблона');
      err.statusCode = 400;
      throw err;
    }
    const b = String(body ?? '');
    let order = sortOrder;
    if (order == null || !Number.isFinite(Number(order))) {
      const maxRes = await query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM question_answer_templates WHERE profile_id = $1`,
        [pid]
      );
      order = Number(maxRes.rows[0]?.next_order ?? 0);
    }
    const result = await query(
      `INSERT INTO question_answer_templates (profile_id, title, body, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING id, profile_id, title, body, sort_order, created_at, updated_at`,
      [pid, t, b, Number(order)]
    );
    return rowToApi(result.rows[0]);
  }

  async update(id, profileId, { title, body, sortOrder }) {
    const existing = await this.findByIdAndProfile(id, profileId);
    if (!existing) {
      const err = new Error('Шаблон не найден');
      err.statusCode = 404;
      throw err;
    }
    const t = title != null ? String(title).trim() : existing.title;
    if (!t) {
      const err = new Error('Укажите название шаблона');
      err.statusCode = 400;
      throw err;
    }
    const b = body != null ? String(body) : existing.body;
    const order =
      sortOrder != null && Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : existing.sortOrder;
    const result = await query(
      `UPDATE question_answer_templates
       SET title = $3, body = $4, sort_order = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND profile_id = $2
       RETURNING id, profile_id, title, body, sort_order, created_at, updated_at`,
      [Number(id), Number(profileId), t, b, order]
    );
    return rowToApi(result.rows[0]);
  }

  async delete(id, profileId) {
    const nid = Number(id);
    const pid = Number(profileId);
    if (!Number.isFinite(nid) || nid < 1 || !Number.isFinite(pid) || pid < 1) return false;
    const result = await query(
      'DELETE FROM question_answer_templates WHERE id = $1 AND profile_id = $2',
      [nid, pid]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export default new QuestionAnswerTemplatesRepositoryPG();
