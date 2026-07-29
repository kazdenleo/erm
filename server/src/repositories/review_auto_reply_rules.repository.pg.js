/**
 * Правила автоответа на отзывы — категории создаёт пользователь.
 * Условия: rating (1–5|null=любой), has_text (true|false|null=любой) → шаблон.
 */

import { query } from '../config/database.js';

function rowToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    title: row.title != null ? String(row.title) : '',
    rating: row.rating != null ? Number(row.rating) : null,
    hasText: row.has_text == null ? null : !!row.has_text,
    templateId: row.template_id != null ? String(row.template_id) : null,
    enabled: !!row.enabled,
    sortOrder: row.sort_order != null ? Number(row.sort_order) : 0,
    templateTitle: row.template_title ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertTemplate(profileId, templateId) {
  if (templateId == null || templateId === '') return null;
  const tid = Number(templateId);
  if (!Number.isFinite(tid) || tid < 1) {
    const err = new Error('Некорректный шаблон');
    err.statusCode = 400;
    throw err;
  }
  const tpl = await query(
    `SELECT id FROM review_reply_templates WHERE id = $1 AND profile_id = $2`,
    [tid, profileId]
  );
  if (!tpl.rows?.[0]) {
    const err = new Error('Шаблон не найден');
    err.statusCode = 404;
    throw err;
  }
  return tid;
}

function parseRating(raw) {
  if (raw == null || raw === '' || raw === 'any' || raw === 'all') return null;
  const rating = Number(raw);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    const err = new Error('Рейтинг должен быть от 1 до 5 или «любой»');
    err.statusCode = 400;
    throw err;
  }
  return Math.round(rating);
}

/** true | false | null (любой) */
function parseHasText(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === 'any' || raw === 'all') return null;
  if (raw === true || raw === 'true' || raw === '1' || raw === 1 || raw === 'yes') return true;
  if (raw === false || raw === 'false' || raw === '0' || raw === 0 || raw === 'no') return false;
  return null;
}

class ReviewAutoReplyRulesRepositoryPG {
  async listByProfile(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];
    const result = await query(
      `SELECT r.id, r.profile_id, r.title, r.rating, r.has_text, r.template_id, r.enabled,
              r.sort_order, r.created_at, r.updated_at, t.title AS template_title
       FROM review_auto_reply_rules r
       LEFT JOIN review_reply_templates t ON t.id = r.template_id
       WHERE r.profile_id = $1
       ORDER BY r.sort_order ASC, r.id ASC`,
      [pid]
    );
    return (result.rows || []).map(rowToApi);
  }

  async listEnabledWithTemplates(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];
    const result = await query(
      `SELECT r.id, r.profile_id, r.title, r.rating, r.has_text, r.template_id, r.enabled,
              r.sort_order, r.created_at, r.updated_at, t.title AS template_title, t.body AS template_body
       FROM review_auto_reply_rules r
       INNER JOIN review_reply_templates t ON t.id = r.template_id
       WHERE r.profile_id = $1
         AND r.enabled = true
         AND r.template_id IS NOT NULL
         AND TRIM(COALESCE(t.body, '')) <> ''
       ORDER BY r.sort_order ASC, r.id ASC`,
      [pid]
    );
    return (result.rows || []).map((row) => ({
      ...rowToApi(row),
      templateBody: row.template_body ?? '',
    }));
  }

  async create(profileId, payload) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Некорректный profile_id');
      err.statusCode = 400;
      throw err;
    }
    const title = String(payload?.title ?? '').trim();
    if (!title) {
      const err = new Error('Укажите название категории');
      err.statusCode = 400;
      throw err;
    }
    const rating = parseRating(payload?.rating);
    const hasText = parseHasText(payload?.hasText);
    const templateId = await assertTemplate(pid, payload?.templateId);
    const enabled = Boolean(payload?.enabled) && templateId != null;
    let sortOrder = payload?.sortOrder;
    if (sortOrder == null || !Number.isFinite(Number(sortOrder))) {
      const maxRes = await query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM review_auto_reply_rules WHERE profile_id = $1`,
        [pid]
      );
      sortOrder = Number(maxRes.rows[0]?.next_order ?? 0);
    }
    const result = await query(
      `INSERT INTO review_auto_reply_rules
         (profile_id, title, rating, has_text, template_id, enabled, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       RETURNING id, profile_id, title, rating, has_text, template_id, enabled, sort_order, created_at, updated_at`,
      [pid, title, rating, hasText, templateId, enabled, Number(sortOrder)]
    );
    return rowToApi(result.rows[0]);
  }

  async update(id, profileId, payload) {
    const nid = Number(id);
    const pid = Number(profileId);
    if (!Number.isFinite(nid) || nid < 1 || !Number.isFinite(pid) || pid < 1) {
      const err = new Error('Правило не найдено');
      err.statusCode = 404;
      throw err;
    }
    const existingRes = await query(
      `SELECT id, title, rating, has_text, template_id, enabled, sort_order
       FROM review_auto_reply_rules WHERE id = $1 AND profile_id = $2`,
      [nid, pid]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      const err = new Error('Правило не найдено');
      err.statusCode = 404;
      throw err;
    }
    const title =
      payload?.title != null ? String(payload.title).trim() : String(existing.title || '').trim();
    if (!title) {
      const err = new Error('Укажите название категории');
      err.statusCode = 400;
      throw err;
    }
    const rating =
      payload && Object.prototype.hasOwnProperty.call(payload, 'rating')
        ? parseRating(payload.rating)
        : existing.rating != null
          ? Number(existing.rating)
          : null;
    const hasText =
      payload && Object.prototype.hasOwnProperty.call(payload, 'hasText')
        ? parseHasText(payload.hasText)
        : existing.has_text == null
          ? null
          : !!existing.has_text;
    const templateId =
      payload && Object.prototype.hasOwnProperty.call(payload, 'templateId')
        ? await assertTemplate(pid, payload.templateId)
        : existing.template_id != null
          ? Number(existing.template_id)
          : null;
    const enabledRaw =
      payload && Object.prototype.hasOwnProperty.call(payload, 'enabled')
        ? Boolean(payload.enabled)
        : !!existing.enabled;
    const enabled = enabledRaw && templateId != null;
    const sortOrder =
      payload?.sortOrder != null && Number.isFinite(Number(payload.sortOrder))
        ? Number(payload.sortOrder)
        : Number(existing.sort_order ?? 0);
    const result = await query(
      `UPDATE review_auto_reply_rules
       SET title = $3, rating = $4, has_text = $5, template_id = $6, enabled = $7,
           sort_order = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND profile_id = $2
       RETURNING id, profile_id, title, rating, has_text, template_id, enabled, sort_order, created_at, updated_at`,
      [nid, pid, title, rating, hasText, templateId, enabled, sortOrder]
    );
    return rowToApi(result.rows[0]);
  }

  async delete(id, profileId) {
    const nid = Number(id);
    const pid = Number(profileId);
    if (!Number.isFinite(nid) || nid < 1 || !Number.isFinite(pid) || pid < 1) return false;
    const result = await query(
      'DELETE FROM review_auto_reply_rules WHERE id = $1 AND profile_id = $2',
      [nid, pid]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Полная замена списка категорий профиля.
   * @param {number} profileId
   * @param {Array<object>} rules
   */
  async replaceAll(profileId, rules) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Некорректный profile_id');
      err.statusCode = 400;
      throw err;
    }
    const list = Array.isArray(rules) ? rules : [];
    await query('DELETE FROM review_auto_reply_rules WHERE profile_id = $1', [pid]);
    let order = 0;
    for (const rule of list) {
      // eslint-disable-next-line no-await-in-loop
      await this.create(pid, { ...rule, sortOrder: order });
      order += 1;
    }
    return this.listByProfile(pid);
  }
}

export default new ReviewAutoReplyRulesRepositoryPG();
