/**
 * Клиенты для частных заказов
 */

import { query } from '../config/database.js';
import { normalizeCustomerPhone, customerPhoneSearchDigits } from '../utils/customerPhone.js';

const CANCELLED_SQL = `LOWER(COALESCE(o.status, '')) IN ('cancelled', 'canceled')`;
const ORDER_GROUP_KEY_SQL = `COALESCE(NULLIF(o.order_group_id, ''), o.order_id)`;

const STATS_CTE = `
  stats AS (
    SELECT o.customer_id,
      COUNT(DISTINCT ${ORDER_GROUP_KEY_SQL}) FILTER (WHERE NOT (${CANCELLED_SQL})) AS orders_count,
      COALESCE(SUM(o.price * o.quantity) FILTER (WHERE NOT (${CANCELLED_SQL})), 0) AS total_amount,
      MIN(o.created_at) AS first_order_at,
      MAX(o.created_at) AS last_order_at
    FROM orders o
    WHERE o.profile_id = $1 AND o.customer_id IS NOT NULL
    GROUP BY o.customer_id
  )`;

const SELECT_COLUMNS = `
  c.id, c.profile_id, c.name, c.phone, c.phone_normalized, c.email, c.address,
  c.birthday, c.source, c.notes, c.created_at, c.updated_at,
  COALESCE(s.orders_count, 0) AS orders_count,
  COALESCE(s.total_amount, 0) AS total_amount,
  s.first_order_at, s.last_order_at`;

const SORT_COLUMNS = {
  name: 'LOWER(c.name)',
  created_at: 'c.created_at',
  last_order_at: 's.last_order_at',
  orders_count: 'COALESCE(s.orders_count, 0)',
  total_amount: 'COALESCE(s.total_amount, 0)',
};

function formatDateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function rowToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    name: row.name ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    birthday: formatDateOnly(row.birthday),
    source: row.source ?? '',
    notes: row.notes ?? '',
    ordersCount: row.orders_count != null ? Number(row.orders_count) : 0,
    totalAmount: row.total_amount != null ? Number(row.total_amount) : 0,
    firstOrderAt: row.first_order_at ?? null,
    lastOrderAt: row.last_order_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Валидация и нормализация полей клиента; partial — только переданные поля (для update). */
function normalizeInput(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);

  if (!partial || has('name')) {
    const name = String(input?.name ?? '').trim();
    if (!name) throw badRequest('Укажите имя клиента');
    out.name = name.slice(0, 255);
  }
  if (!partial || has('phone')) {
    const phone = String(input?.phone ?? '').trim().slice(0, 50);
    out.phone = phone;
    out.phone_normalized = normalizeCustomerPhone(phone);
  }
  if (!partial || has('email')) {
    const email = String(input?.email ?? '').trim().slice(0, 255);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('Некорректный email');
    }
    out.email = email;
  }
  if (!partial || has('address')) {
    out.address = String(input?.address ?? '').trim();
  }
  if (!partial || has('birthday')) {
    const raw = input?.birthday;
    if (raw == null || String(raw).trim() === '') {
      out.birthday = null;
    } else {
      const s = String(raw).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
        throw badRequest('Некорректная дата рождения');
      }
      out.birthday = s;
    }
  }
  if (!partial || has('source')) {
    out.source = String(input?.source ?? '').trim().slice(0, 120);
  }
  if (!partial || has('notes')) {
    out.notes = String(input?.notes ?? '');
  }
  return out;
}

function mapUniqueViolation(error) {
  if (error?.code === '23505') {
    return badRequest('Клиент с таким телефоном уже есть в базе', 409);
  }
  return error;
}

class CustomersRepositoryPG {
  /**
   * @param {number} profileId
   * @param {{ search?: string, sort?: string, dir?: 'asc'|'desc', limit?: number, offset?: number }} [options]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async list(profileId, options = {}) {
    const pid = toPositiveInt(profileId);
    if (!pid) return { items: [], total: 0 };

    const params = [pid];
    let where = 'WHERE c.profile_id = $1';
    const search = String(options.search ?? '').trim();
    if (search) {
      params.push(`%${search}%`);
      const likeIdx = params.length;
      const digits = customerPhoneSearchDigits(search);
      let phoneSql = '';
      if (digits) {
        params.push(`%${digits}%`);
        phoneSql = ` OR c.phone_normalized LIKE $${params.length}`;
      }
      where += ` AND (c.name ILIKE $${likeIdx} OR c.email ILIKE $${likeIdx} OR c.phone ILIKE $${likeIdx}
        OR c.address ILIKE $${likeIdx}${phoneSql})`;
    }

    const sortCol = SORT_COLUMNS[options.sort] || SORT_COLUMNS.name;
    const dir = String(options.dir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(500, toPositiveInt(options.limit) || 100);
    const offset = Math.max(0, Number(options.offset) || 0);
    params.push(limit, offset);

    const result = await query(
      `WITH ${STATS_CTE}
       SELECT ${SELECT_COLUMNS}, COUNT(*) OVER () AS total_count
       FROM customers c
       LEFT JOIN stats s ON s.customer_id = c.id
       ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, c.id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const rows = result.rows || [];
    let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    if (rows.length === 0 && offset > 0) {
      const cnt = await query(`SELECT COUNT(*)::int AS n FROM customers c ${where}`, params.slice(0, -2));
      total = Number(cnt.rows[0]?.n ?? 0);
    }
    return { items: rows.map(rowToApi), total };
  }

  async findByIdAndProfile(id, profileId) {
    const nid = toPositiveInt(id);
    const pid = toPositiveInt(profileId);
    if (!nid || !pid) return null;
    const result = await query(
      `WITH ${STATS_CTE}
       SELECT ${SELECT_COLUMNS}
       FROM customers c
       LEFT JOIN stats s ON s.customer_id = c.id
       WHERE c.profile_id = $1 AND c.id = $2`,
      [pid, nid]
    );
    return rowToApi(result.rows[0] || null);
  }

  async findByPhone(profileId, phone) {
    const pid = toPositiveInt(profileId);
    const pn = normalizeCustomerPhone(phone);
    if (!pid || !pn) return null;
    const result = await query(
      `SELECT id FROM customers WHERE profile_id = $1 AND phone_normalized = $2 LIMIT 1`,
      [pid, pn]
    );
    const id = result.rows[0]?.id;
    return id != null ? this.findByIdAndProfile(id, pid) : null;
  }

  async create(profileId, input) {
    const pid = toPositiveInt(profileId);
    if (!pid) throw badRequest('Некорректный profile_id');
    const v = normalizeInput(input);
    try {
      const result = await query(
        `INSERT INTO customers (profile_id, name, phone, phone_normalized, email, address, birthday, source, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
         RETURNING id`,
        [pid, v.name, v.phone, v.phone_normalized, v.email, v.address, v.birthday, v.source, v.notes]
      );
      return this.findByIdAndProfile(result.rows[0].id, pid);
    } catch (error) {
      throw mapUniqueViolation(error);
    }
  }

  async update(id, profileId, input) {
    const existing = await this.findByIdAndProfile(id, profileId);
    if (!existing) throw badRequest('Клиент не найден', 404);
    const v = normalizeInput(input, { partial: true });
    const fields = Object.keys(v);
    if (fields.length === 0) return existing;
    const params = [Number(id), Number(profileId)];
    const sets = fields.map((f) => {
      params.push(v[f]);
      return `${f} = $${params.length}`;
    });
    try {
      await query(
        `UPDATE customers SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND profile_id = $2`,
        params
      );
    } catch (error) {
      throw mapUniqueViolation(error);
    }
    return this.findByIdAndProfile(id, profileId);
  }

  async delete(id, profileId) {
    const nid = toPositiveInt(id);
    const pid = toPositiveInt(profileId);
    if (!nid || !pid) return false;
    const result = await query('DELETE FROM customers WHERE id = $1 AND profile_id = $2', [nid, pid]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Заказы клиента, сгруппированные по order_group_id / order_id (новые сверху). */
  async listOrders(customerId, profileId) {
    const cid = toPositiveInt(customerId);
    const pid = toPositiveInt(profileId);
    if (!cid || !pid) return [];
    const result = await query(
      `SELECT ${ORDER_GROUP_KEY_SQL} AS group_key,
         MIN(o.marketplace) AS marketplace,
         MIN(o.created_at) AS created_at,
         (ARRAY_AGG(o.status ORDER BY o.id))[1] AS status,
         SUM(o.price * o.quantity) AS total_amount,
         SUM(o.quantity) AS items_qty,
         COUNT(*) AS lines_count,
         STRING_AGG(COALESCE(o.product_name, '—') || ' × ' || o.quantity, ', ' ORDER BY o.id) AS items_summary,
         BOOL_OR(o.archived_at IS NOT NULL) AS archived
       FROM orders o
       WHERE o.profile_id = $1 AND o.customer_id = $2
       GROUP BY ${ORDER_GROUP_KEY_SQL}
       ORDER BY MIN(o.created_at) DESC
       LIMIT 500`,
      [pid, cid]
    );
    return (result.rows || []).map((r) => ({
      orderId: r.group_key,
      marketplace: r.marketplace,
      createdAt: r.created_at,
      status: r.status,
      totalAmount: r.total_amount != null ? Number(r.total_amount) : 0,
      itemsQty: r.items_qty != null ? Number(r.items_qty) : 0,
      linesCount: r.lines_count != null ? Number(r.lines_count) : 0,
      itemsSummary: r.items_summary ?? '',
      archived: r.archived === true,
    }));
  }
}

export default new CustomersRepositoryPG();
