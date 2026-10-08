/**
 * Справочник постоянных и разовых расходов компании для ОПиУ.
 */

import { query } from '../config/database.js';
import { requireAnalyticsProfile, parseDateYmd } from '../utils/analyticsCommon.js';

export const EXPENSE_CATEGORIES = [
  'Аренда',
  'Зарплата',
  'Подписки и сервисы',
  'Реклама',
  'Логистика до склада МП',
  'Упаковка и материалы',
  'Банк и РКО',
  'Налоги и взносы (фикс.)',
  'Прочее',
];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function mapRow(r) {
  return {
    id: Number(r.id),
    organizationId: r.organization_id != null ? Number(r.organization_id) : null,
    organizationName: r.organization_name || null,
    marketplace: r.marketplace || null,
    category: r.category,
    description: r.description || '',
    amount: Number(r.amount) || 0,
    startDate: r.start_date_ymd,
    recurrence: r.recurrence,
    endDate: r.end_date_ymd || null,
    createdAt: r.created_at,
  };
}

async function normalizePayload(pid, body = {}) {
  const category = String(body.category || '').trim().slice(0, 100);
  if (!category) throw badRequest('Укажите статью расхода');
  const amount = Number(String(body.amount ?? '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('Сумма должна быть неотрицательным числом');
  const startDate = parseDateYmd(body.startDate);
  if (!startDate) throw badRequest('Укажите дату (месяц) расхода');
  const recurrence = body.recurrence === 'monthly' ? 'monthly' : 'once';
  const endDate = recurrence === 'monthly' ? parseDateYmd(body.endDate) : null;
  if (endDate && endDate < startDate) throw badRequest('Дата окончания раньше даты начала');
  const mpRaw = String(body.marketplace || '').trim().toLowerCase();
  const marketplace = ['ozon', 'wb', 'ym'].includes(mpRaw) ? mpRaw : null;
  let organizationId = null;
  if (body.organizationId != null && String(body.organizationId).trim() !== '') {
    const oid = Number(body.organizationId);
    const org = await query('SELECT id FROM organizations WHERE id = $1 AND profile_id = $2', [oid, pid]);
    if (!org.rows?.length) throw badRequest('Организация не найдена');
    organizationId = oid;
  }
  const description = String(body.description || '').trim().slice(0, 1000) || null;
  return { category, amount, startDate, recurrence, endDate, marketplace, organizationId, description };
}

const SELECT_SQL = `
  SELECT e.*, to_char(e.start_date, 'YYYY-MM-DD') AS start_date_ymd,
         to_char(e.end_date, 'YYYY-MM-DD') AS end_date_ymd,
         o.name AS organization_name
    FROM company_expenses e
    LEFT JOIN organizations o ON o.id = e.organization_id`;

class CompanyExpensesService {
  async list({ profileId } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const r = await query(`${SELECT_SQL} WHERE e.profile_id = $1 ORDER BY e.start_date DESC, e.id DESC`, [pid]);
    return { categories: EXPENSE_CATEGORIES, items: (r.rows || []).map(mapRow) };
  }

  /** Сырые строки для расчёта ОПиУ. */
  async listForProfile(pid) {
    const r = await query(`${SELECT_SQL} WHERE e.profile_id = $1`, [pid]);
    return (r.rows || []).map(mapRow);
  }

  async create({ profileId, userId = null, body }) {
    const pid = requireAnalyticsProfile(profileId);
    const p = await normalizePayload(pid, body);
    const r = await query(
      `INSERT INTO company_expenses
         (profile_id, organization_id, marketplace, category, description, amount, start_date, recurrence, end_date, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [pid, p.organizationId, p.marketplace, p.category, p.description, p.amount, p.startDate, p.recurrence, p.endDate, userId]
    );
    return this.getById(pid, r.rows[0].id);
  }

  async update({ profileId, id, body }) {
    const pid = requireAnalyticsProfile(profileId);
    const p = await normalizePayload(pid, body);
    const r = await query(
      `UPDATE company_expenses
          SET organization_id = $3, marketplace = $4, category = $5, description = $6, amount = $7,
              start_date = $8, recurrence = $9, end_date = $10, updated_at = NOW()
        WHERE id = $1 AND profile_id = $2
        RETURNING id`,
      [Number(id), pid, p.organizationId, p.marketplace, p.category, p.description, p.amount, p.startDate, p.recurrence, p.endDate]
    );
    if (!r.rows?.length) {
      const err = new Error('Расход не найден');
      err.statusCode = 404;
      throw err;
    }
    return this.getById(pid, id);
  }

  async remove({ profileId, id }) {
    const pid = requireAnalyticsProfile(profileId);
    const r = await query('DELETE FROM company_expenses WHERE id = $1 AND profile_id = $2', [Number(id), pid]);
    if (!r.rowCount) {
      const err = new Error('Расход не найден');
      err.statusCode = 404;
      throw err;
    }
    return { deleted: true };
  }

  async getById(pid, id) {
    const r = await query(`${SELECT_SQL} WHERE e.id = $1 AND e.profile_id = $2`, [Number(id), pid]);
    return r.rows?.[0] ? mapRow(r.rows[0]) : null;
  }
}

export default new CompanyExpensesService();
