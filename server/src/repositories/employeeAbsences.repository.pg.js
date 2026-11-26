/**
 * Пропуски сотрудников (employee_absence_days).
 */

import { query } from '../config/database.js';

function dateText(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

class EmployeeAbsencesRepositoryPG {
  async listForUserMonth(userId, yearMonth) {
    const ym = String(yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return [];
    const result = await query(
      `SELECT id, profile_id, user_id, absence_date::text AS absence_date, note, created_by_user_id, created_at
       FROM employee_absence_days
       WHERE user_id = $1
         AND absence_date >= ($2 || '-01')::date
         AND absence_date < (($2 || '-01')::date + INTERVAL '1 month')
       ORDER BY absence_date ASC`,
      [userId, ym]
    );
    return (result.rows || []).map((row) => ({
      ...row,
      absence_date: dateText(row.absence_date),
    }));
  }

  async listForProfileMonth(profileId, yearMonth) {
    const ym = String(yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return [];
    const result = await query(
      `SELECT id, profile_id, user_id, absence_date::text AS absence_date, note, created_by_user_id, created_at
       FROM employee_absence_days
       WHERE profile_id = $1
         AND absence_date >= ($2 || '-01')::date
         AND absence_date < (($2 || '-01')::date + INTERVAL '1 month')
       ORDER BY user_id ASC, absence_date ASC`,
      [profileId, ym]
    );
    return (result.rows || []).map((row) => ({
      ...row,
      absence_date: dateText(row.absence_date),
    }));
  }

  async listForUserRange(userId, dateFrom, dateTo) {
    const from = String(dateFrom || '').slice(0, 10);
    const to = String(dateTo || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
    const result = await query(
      `SELECT id, profile_id, user_id, absence_date::text AS absence_date, note, created_by_user_id, created_at
       FROM employee_absence_days
       WHERE user_id = $1
         AND absence_date >= $2::date
         AND absence_date <= $3::date
       ORDER BY absence_date ASC`,
      [userId, from, to]
    );
    return (result.rows || []).map((row) => ({
      ...row,
      absence_date: dateText(row.absence_date),
    }));
  }

  async listForProfileRange(profileId, dateFrom, dateTo) {
    const from = String(dateFrom || '').slice(0, 10);
    const to = String(dateTo || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
    const result = await query(
      `SELECT id, profile_id, user_id, absence_date::text AS absence_date, note, created_by_user_id, created_at
       FROM employee_absence_days
       WHERE profile_id = $1
         AND absence_date >= $2::date
         AND absence_date <= $3::date
       ORDER BY user_id ASC, absence_date ASC`,
      [profileId, from, to]
    );
    return (result.rows || []).map((row) => ({
      ...row,
      absence_date: dateText(row.absence_date),
    }));
  }

  async addDay({ profileId, userId, absenceDate, note = null, createdByUserId = null }) {
    const result = await query(
      `INSERT INTO employee_absence_days (profile_id, user_id, absence_date, note, created_by_user_id)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (user_id, absence_date) DO UPDATE
         SET note = COALESCE(EXCLUDED.note, employee_absence_days.note)
       RETURNING id, profile_id, user_id, absence_date::text AS absence_date, note, created_by_user_id, created_at`,
      [profileId, userId, absenceDate, note, createdByUserId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, absence_date: dateText(row.absence_date) };
  }

  async removeDay(userId, absenceDate) {
    const result = await query(
      `DELETE FROM employee_absence_days
       WHERE user_id = $1 AND absence_date = $2::date
       RETURNING id`,
      [userId, absenceDate]
    );
    return result.rows.length > 0;
  }

  async replaceMonthDays({ profileId, userId, yearMonth, dates, createdByUserId = null }) {
    const ym = String(yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      const err = new Error('Укажите месяц в формате YYYY-MM');
      err.status = 400;
      throw err;
    }
    const unique = [
      ...new Set(
        (dates || [])
          .map((d) => String(d || '').slice(0, 10))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d.startsWith(`${ym}-`))
      ),
    ].sort();

    await query(
      `DELETE FROM employee_absence_days
       WHERE user_id = $1
         AND absence_date >= ($2 || '-01')::date
         AND absence_date < (($2 || '-01')::date + INTERVAL '1 month')`,
      [userId, ym]
    );

    for (const day of unique) {
      await query(
        `INSERT INTO employee_absence_days (profile_id, user_id, absence_date, created_by_user_id)
         VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (user_id, absence_date) DO NOTHING`,
        [profileId, userId, day, createdByUserId]
      );
    }

    return this.listForUserMonth(userId, ym);
  }
}

export default new EmployeeAbsencesRepositoryPG();
